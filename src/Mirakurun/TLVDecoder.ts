/*
   Copyright 2026 kanreisa

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
import * as child_process from "child_process";
import * as stream from "stream";
import * as common from "./common";
import * as log from "./log";
import status from "./status";

export type TLVOutputFormat = "ts" | "tlv";

interface TLVDecoderOptions {
    readonly output: stream.Writable;
    readonly command: string;
    readonly startupTimeout?: number;
    readonly onError?: (error: Error) => void;
}

/** The independent B61 and TLV-to-TS stages for a TLV input stream. */
export interface TLVDecoderFactoryOptions {
    readonly output?: stream.Writable;
    readonly outputFormat?: TLVOutputFormat;
    readonly tlvDecoder?: string;
    readonly tlvToTsDecoder?: string;
    readonly disableDecoder?: boolean;
    readonly onError?: (error: Error) => void;
}

const DEFAULT_STARTUP_TIMEOUT = 10000;

let idCounter = 0;

/**
 * Pipes a TLV stream through one external conversion stage.  Unlike the
 * legacy in-device mmtsDecoder this is per stream, so B61 decryption and
 * container conversion can be selected independently by the request.
 */
export default class TLVDecoder extends stream.Writable {

    static create(opts: TLVDecoderFactoryOptions): stream.Writable | undefined {
        // Metadata collection has no consumer.  Do not launch B61 or remuxing
        // processes just because a filter is parsing PSI/SI in the background.
        if (!opts.output) {
            return undefined;
        }

        if (opts.outputFormat === "tlv") {
            return !opts.disableDecoder && opts.tlvDecoder
                ? new TLVDecoder({ output: opts.output, command: opts.tlvDecoder, onError: opts.onError })
                : opts.output;
        }

        let input: stream.Writable = opts.output;
        if (opts.tlvToTsDecoder) {
            input = new TLVDecoder({ output: input, command: opts.tlvToTsDecoder, onError: opts.onError });
        }
        if (!opts.disableDecoder && opts.tlvDecoder) {
            input = new TLVDecoder({ output: input, command: opts.tlvDecoder, onError: opts.onError });
        }
        return input;
    }

    private readonly _id = idCounter++;
    private readonly _command: string;
    private readonly _startupTimeout: number;
    private _output: stream.Writable | undefined;
    private _process: child_process.ChildProcess | undefined;
    private _readable: stream.Readable | undefined;
    private _writable: stream.Writable | undefined;
    private _timeout: NodeJS.Timeout | undefined;
    private _closed = false;
    private _inputStarted = false;
    private _outputStarted = false;
    private _inputEnded = false;
    private _inputFinished = false;
    private _processClosed = false;
    private _stdoutEnded = false;
    private _pendingOutputWrites = 0;
    private readonly _onError?: (error: Error) => void;
    private readonly _onOutputClose: () => void;
    private readonly _onOutputError: (error: Error) => void;

    constructor(opts: TLVDecoderOptions) {
        // Input finish precedes child stdout drain. Keep ownership until the
        // process and its output have both completed, or the client cancels.
        super({ autoDestroy: false });
        this._command = opts.command;
        this._startupTimeout = opts.startupTimeout || DEFAULT_STARTUP_TIMEOUT;
        this._onError = opts.onError;
        this._onOutputClose = () => this._cancel();
        this._onOutputError = error => this._fail(error);
        this._output = opts.output;
        this._output.once("finish", this._onOutputClose);
        this._output.once("close", this._onOutputClose);
        this._output.once("error", this._onOutputError);
        Object.defineProperty(this, "writableLength", { get: () => opts.output.writableLength });
        Object.defineProperty(this, "writableHighWaterMark", { get: () => opts.output.writableHighWaterMark });
        this.once("close", () => this._cancel());
        this.on("error", error => this._fail(error));
        ++status.streamCount.decoder;
        log.info("TLVDecoder#%d has created (command=%s)", this._id, this._command);
        this._spawn();
    }

    _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        if (!this._writable || this._closed) { callback(); return; }
        if (!this._inputStarted) {
            this._inputStarted = true;
            if (!this._outputStarted) {
                this._timeout = setTimeout(() => {
                    this._fail(new Error("TLV decoder produced no output before startup timeout"));
                }, this._startupTimeout);
            }
        }
        this._writable.write(chunk, error => callback(this._closed ? undefined : error));
    }

    _final(callback: (error?: Error | null) => void): void {
        this._inputEnded = true;
        if (!this._writable || this._closed) { callback(); return; }
        this._writable.end((error?: Error) => {
            // Cancellation can destroy stdin after end() but before its callback.
            // The request has already been cancelled/failed; do not emit a second
            // Writable error from that deliberately interrupted finalization.
            if (this._closed) { callback(); return; }
            if (error) { callback(error); return; }
            this._inputFinished = true;
            callback();
            this._finish();
        });
    }

    private _spawn(): void {
        const parsed = common.parseCommandForSpawn(this._command);
        const proc = this._process = child_process.spawn(parsed.command, parsed.args);
        proc.once("error", error => this._fail(error));
        proc.once("close", (code, signal) => {
            if (this._closed) { return; }
            log.info("TLVDecoder#%d process closed with exit code=%s signal=%s (pid=%d)", this._id, code, signal, proc.pid);
            if (code !== 0 || signal || !this._inputEnded) {
                this._fail(new Error(`TLV decoder exited unexpectedly (code=${code}, signal=${signal})`));
                return;
            }
            this._processClosed = true;
            this._finish();
        });
        proc.stderr.pipe(process.stderr);
        proc.stdin.on("error", error => this._fail(error));
        proc.stdout.on("error", error => this._fail(error));
        proc.stdout.once("data", () => {
            this._outputStarted = true;
            clearTimeout(this._timeout);
            this._timeout = undefined;
        });
        proc.stdout.on("data", chunk => {
            const output = this._output;
            if (!output || this._closed) { return; }
            ++this._pendingOutputWrites;
            output.write(chunk, error => {
                --this._pendingOutputWrites;
                if (error) { this._fail(error); return; }
                this._finish();
            });
        });
        proc.stdout.once("end", () => {
            this._stdoutEnded = true;
            this._finish();
        });
        this._readable = proc.stdout;
        this._writable = proc.stdin;
        log.info("TLVDecoder#%d spawned by command `%s` (pid=%d)", this._id, this._command, proc.pid);
    }

    private _finish(): void {
        if (this._closed || !this._inputFinished || !this._processClosed ||
            !this._stdoutEnded || this._pendingOutputWrites !== 0) { return; }
        const output = this._output;
        this._stop();
        if (output && !output.destroyed && !output.writableEnded) { output.end(); }
    }

    private _fail(error: Error): void {
        if (this._closed) { return; }
        const output = this._output;
        log.error("TLVDecoder#%d failed: %s (command=%s)", this._id, error.message, this._command);
        this._stop();
        // The stream owner sends HTTP 503 before headers, or aborts an already
        // streaming response. Tear down chained stages without ending HTTP as OK.
        this._onError?.(error);
        if (output instanceof TLVDecoder || !this._onError) { output?.destroy(); }
    }

    private _cancel(): void {
        if (this._closed) { return; }
        const output = this._output;
        this._stop();
        if (output && !output.destroyed && !output.writableFinished &&
            (output instanceof TLVDecoder || !this._onError)) { output.destroy(); }
    }

    private _stop(): void {
        this._closed = true;
        clearTimeout(this._timeout);
        this._output?.removeListener("finish", this._onOutputClose);
        this._output?.removeListener("close", this._onOutputClose);
        this._output?.removeListener("error", this._onOutputError);
        this._output = undefined;
        if (!this._processClosed) { this._process?.kill("SIGKILL"); }
        this._process = undefined;
        this._readable?.destroy();
        this._readable = undefined;
        this._writable?.destroy();
        this._writable = undefined;
        --status.streamCount.decoder;
        this.destroy();
        log.info("TLVDecoder#%d has closed (command=%s)", this._id, this._command);
    }
}
