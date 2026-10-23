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
}

/** The independent B61 and TLV-to-TS stages for a TLV input stream. */
export interface TLVDecoderFactoryOptions {
    readonly output?: stream.Writable;
    readonly outputFormat?: TLVOutputFormat;
    readonly tlvDecoder?: string;
    readonly tlvToTsDecoder?: string;
    readonly disableDecoder?: boolean;
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
                ? new TLVDecoder({ output: opts.output, command: opts.tlvDecoder })
                : opts.output;
        }

        let input: stream.Writable = opts.output;
        if (opts.tlvToTsDecoder) {
            input = new TLVDecoder({ output: input, command: opts.tlvToTsDecoder });
        }
        if (!opts.disableDecoder && opts.tlvDecoder) {
            input = new TLVDecoder({ output: input, command: opts.tlvDecoder });
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
    private _isNew = false;
    private _timeout: NodeJS.Timeout | undefined;
    private _closed = false;
    private _deadCount = 0;

    constructor(opts: TLVDecoderOptions) {
        // `Writable` otherwise auto-destroys on finalization and emits close
        // before the child has drained stdout, which would kill the decoder.
        super({ autoDestroy: false });
        this._command = opts.command;
        this._startupTimeout = opts.startupTimeout || DEFAULT_STARTUP_TIMEOUT;
        this._output = opts.output;
        this._output.once("finish", this._close.bind(this));
        this._output.once("close", this._close.bind(this));
        Object.defineProperty(this, "writableLength", { get: () => opts.output.writableLength });
        Object.defineProperty(this, "writableHighWaterMark", { get: () => opts.output.writableHighWaterMark });
        this.once("close", this._close.bind(this));
        ++status.streamCount.decoder;
        log.info("TLVDecoder#%d has created (command=%s)", this._id, this._command);
        this._spawn();
    }

    _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        if (!this._writable) {
            callback();
            return;
        }
        if (this._isNew && this._process) {
            this._isNew = false;
            this._timeout = setTimeout(() => {
                log.warn("TLVDecoder#%d process will force killed because no response", this._id);
                this._dead();
            }, this._startupTimeout);
        }
        this._writable.write(chunk, callback);
    }

    _final(callback: (error?: Error | null) => void): void {
        if (!this._writable || this._closed) {
            callback();
            return;
        }
        this._writable.end(callback);
    }

    private _spawn(): void {
        if (this._closed || this._process) { return; }
        if (this._deadCount > 0) {
            ++status.errorCount.decoderRespawn;
            log.warn("TLVDecoder#%d respawning because dead (count=%d)", this._id, this._deadCount);
        }
        const parsed = common.parseCommandForSpawn(this._command);
        const proc = this._process = child_process.spawn(parsed.command, parsed.args);
        proc.once("error", err => {
            if (this._process !== proc) { return; }
            log.error("TLVDecoder#%d process error: %s", this._id, err.message);
            this._dead();
        });
        proc.once("close", (code, signal) => {
            if (this._process !== proc) { return; }
            log.info("TLVDecoder#%d process closed with exit code=%d signal=%s (pid=%d)", this._id, code, signal, proc.pid);
            this._dead();
        });
        proc.stderr.pipe(process.stderr);
        proc.stdout.once("data", () => {
            if (this._timeout) { clearTimeout(this._timeout); }
        });
        let stdoutEnded = false;
        let pendingOutputWrites = 0;
        const closeWhenFlushed = () => {
            if (stdoutEnded && pendingOutputWrites === 0) {
                this._close();
            }
        };
        proc.stdout.on("data", chunk => {
            const output = this._output;
            if (!output) { return; }
            ++pendingOutputWrites;
            output.write(chunk, () => {
                --pendingOutputWrites;
                closeWhenFlushed();
            });
        });
        proc.stdout.once("end", () => {
            stdoutEnded = true;
            closeWhenFlushed();
        });
        this._readable = proc.stdout;
        this._writable = proc.stdin;
        this._isNew = true;
        log.info("TLVDecoder#%d spawned by command `%s` (pid=%d)", this._id, this._command, proc.pid);
    }

    private _dead(): void {
        if (this._closed) { return; }
        ++this._deadCount;
        this._kill();
        if (this._deadCount > 3) {
            const error = new Error(`TLV decoder unavailable: ${this._command}`);
            log.error("TLVDecoder#%d %s", this._id, error.message);
            this.destroy(error);
            this._output?.destroy(error);
            return;
        }
        setTimeout(() => this._spawn(), 1500);
    }

    private _kill(): void {
        if (this._timeout) { clearTimeout(this._timeout); this._timeout = undefined; }
        this._process?.kill("SIGKILL");
        this._process = undefined;
        this._readable?.destroy();
        this._readable = undefined;
        this._writable?.destroy();
        this._writable = undefined;
    }

    private _close(): void {
        if (this._closed) { return; }
        this._closed = true;
        this._kill();
        if (this._output && !this._output.writableEnded) { this._output.end(); }
        this._output = undefined;
        --status.streamCount.decoder;
        log.info("TLVDecoder#%d has closed (command=%s)", this._id, this._command);
    }
}
