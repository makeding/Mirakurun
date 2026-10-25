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
import { TLVStreamProtection } from "../../api";
import { StreamByteBudget, StreamStageError, streamProtection, redactStreamText } from "./StreamFailure";
import BoundedStreamOutput from "./BoundedStreamOutput";

export type TLVOutputFormat = "ts" | "tlv";

interface TLVDecoderOptions {
    readonly output: stream.Writable;
    readonly command: string;
    readonly startupTimeout?: number;
    readonly protection?: TLVStreamProtection;
    readonly budget?: StreamByteBudget;
    readonly stage?: string;
    readonly onError?: (error: Error) => void;
}

/** The independent B61 and TLV-to-TS stages for a TLV input stream. */
export interface TLVDecoderFactoryOptions {
    readonly protection?: TLVStreamProtection;
    readonly output?: stream.Writable;
    readonly outputFormat?: TLVOutputFormat;
    readonly tlvDecoder?: string;
    readonly tlvToTsDecoder?: string;
    readonly disableDecoder?: boolean;
    readonly onError?: (error: Error) => void;
}

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

        const protection = streamProtection(opts.protection);
        const budget = new StreamByteBudget(protection.maxBufferBytes);
        const onError = opts.onError || (() => opts.output.destroy());
        let input: stream.Writable = new BoundedStreamOutput(opts.output, budget, protection, onError);
        if (opts.outputFormat !== "tlv" && opts.tlvToTsDecoder) {
            input = new TLVDecoder({ output: input, command: opts.tlvToTsDecoder, onError, protection, budget, stage: "conversion" });
        }
        if (!opts.disableDecoder && opts.tlvDecoder) {
            input = new TLVDecoder({ output: input, command: opts.tlvDecoder, onError, protection, budget, stage: "decryption" });
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
    private readonly _protection: Required<TLVStreamProtection>;
    private readonly _budget: StreamByteBudget;
    private readonly _stage: string;
    private readonly _watchdog: NodeJS.Timeout;
    private _inputBytes = 0;
    private _outputBytes = 0;
    private _firstInputAt = 0;
    private _lastInputAt = 0;
    private _lastOutputAt = 0;
    private _endingAt = 0;
    private _blockedAt = 0;
    private _stderr = "";
    private readonly _drainOutput: () => void;
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
        this._drainOutput = () => { this._blockedAt = 0; this._readable?.resume(); };
        this._protection = streamProtection(opts.protection);
        this._budget = opts.budget || new StreamByteBudget(this._protection.maxBufferBytes);
        this._stage = opts.stage || "conversion";
        this._watchdog = setInterval(() => this._checkProgress(), Math.max(10, Math.min(250,
            this._protection.stallTimeoutMs / 4, this._protection.sourceTimeoutMs / 4,
            this._protection.outputTimeoutMs / 4, this._protection.drainTimeoutMs / 4)));
        this._watchdog.unref();
        this._startupTimeout = opts.startupTimeout || this._protection.startupTimeoutMs;
        this._onError = opts.onError;
        this._onOutputClose = () => this._cancel();
        this._onOutputError = error => this._fail(error);
        this._output = opts.output;
        this._output.once("finish", this._onOutputClose);
        this._output.once("close", this._onOutputClose);
        this._output.once("error", this._onOutputError);
        this.once("close", () => this._cancel());
        this.on("error", error => this._fail(error));
        ++status.streamCount.decoder;
        log.info("TLVDecoder#%d has created (stage=%s)", this._id, this._stage);
        this._spawn();
    }

    write(chunk: any, encoding?: any, callback?: any): boolean {
        const cb = typeof encoding === "function" ? encoding : callback;
        if (this._closed) { cb?.(); return false; }
        const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, typeof encoding === "string" ? encoding as BufferEncoding : undefined);
        if (!this._budget.reserve(bytes)) {
            this._failure("BUFFER_LIMIT", "The request exceeded its stream buffer limit.");
            cb?.();
            return false;
        }
        this._inputBytes += bytes;
        this._lastInputAt = Date.now();
        this._firstInputAt ||= this._lastInputAt;
        return super.write(chunk, typeof encoding === "string" ? encoding as BufferEncoding : undefined, error => {
            this._budget.release(bytes);
            cb?.(this._closed ? undefined : error);
        });
    }

    end(chunk?: any, encoding?: any, callback?: any): this {
        this._endingAt ||= Date.now();
        const cb = typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : callback;
        if (chunk !== null && chunk !== undefined && typeof chunk !== "function") { this.write(chunk, typeof encoding === "string" ? encoding : undefined); }
        return super.end(cb);
    }

    _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        if (!this._writable || this._closed) { callback(); return; }
        if (!this._inputStarted) {
            this._inputStarted = true;
            if (!this._outputStarted) {
                this._timeout = setTimeout(() => {
                    this._failure("STARTUP_TIMEOUT", "The converter produced no output after receiving input.");
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

    private _checkProgress(): void {
        if (this._closed) { return; }
        const now = Date.now();
        if (this._blockedAt) {
            if (now - this._blockedAt >= this._protection.outputTimeoutMs) {
                this._failure("OUTPUT_STALLED", "The downstream stream stopped accepting data.");
            }
            return;
        }
        if (this._endingAt) {
            if (now - this._endingAt >= this._protection.drainTimeoutMs) {
                this._failure("DRAIN_TIMEOUT", "The converter did not finish after input ended.");
            }
            return;
        }
        if (!this._firstInputAt) { return; }
        if (now - this._lastInputAt >= this._protection.sourceTimeoutMs) {
            this._failure("SOURCE_STALLED", "The broadcast source stopped sending data.");
        } else if (this._outputStarted && this._lastInputAt > this._lastOutputAt &&
                   now - this._lastOutputAt >= this._protection.stallTimeoutMs &&
                   now - this._lastInputAt < this._protection.stallTimeoutMs) {
            this._failure("DECODER_STALLED", "Input is arriving but the converter stopped producing output.");
        }
    }

    private _failure(code: string, reason: string, exitCode?: number, signal?: string): void {
        this._fail(new StreamStageError({ stage: this._stage, code, reason,
            inputBytes: this._inputBytes, outputBytes: this._outputBytes,
            lastInputAt: this._lastInputAt || undefined, lastOutputAt: this._lastOutputAt || undefined,
            exitCode, signal, stderr: redactStreamText(this._stderr).slice(-4096) }));
    }

    private _spawn(): void {
        const parsed = common.parseCommandForSpawn(this._command);
        const proc = this._process = child_process.spawn(parsed.command, parsed.args);
        proc.once("error", () => this._failure("SPAWN_FAILED", "The configured converter could not be started."));
        proc.once("close", (code, signal) => {
            if (this._closed) { return; }
            log.info("TLVDecoder#%d process closed with exit code=%s signal=%s (pid=%d)", this._id, code, signal, proc.pid);
            if (code !== 0 || signal || !this._inputEnded) {
                this._failure("DECODER_EXIT", "The converter exited before the stream completed.", code ?? undefined, signal ?? undefined);
                return;
            }
            this._processClosed = true;
            this._finish();
        });
        proc.stderr.on("data", chunk => {
            this._stderr = (this._stderr + chunk.toString("utf8")).slice(-8192);
        });
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
            this._outputBytes += chunk.length;
            this._lastOutputAt = Date.now();
            const ready = output.write(chunk, error => {
                --this._pendingOutputWrites;
                if (error) { this._fail(error); return; }
                this._finish();
            });
            if (!ready && !this._closed) {
                this._blockedAt ||= Date.now();
                proc.stdout.pause();
                output.once("drain", this._drainOutput);
            }
        });
        proc.stdout.once("end", () => {
            this._stdoutEnded = true;
            this._finish();
        });
        this._readable = proc.stdout;
        this._writable = proc.stdin;
        log.info("TLVDecoder#%d spawned (stage=%s pid=%d)", this._id, this._stage, proc.pid);
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
        if (!(error instanceof StreamStageError)) {
            this._failure("DECODER_IO", "The converter stream encountered an I/O error.");
            return;
        }
        const output = this._output;
        log.error("TLVDecoder#%d failed: %s", this._id, error.message);
        this._stop();
        // The stream owner sends HTTP 503 before headers, or aborts an already
        // streaming response. Tear down chained stages without ending HTTP as OK.
        this._onError?.(error);
        if (output instanceof TLVDecoder || output instanceof BoundedStreamOutput || !this._onError) { output?.destroy(); }
    }

    private _cancel(): void {
        if (this._closed) { return; }
        const output = this._output;
        this._stop();
        if (output && !output.destroyed && !output.writableFinished &&
            (output instanceof TLVDecoder || output instanceof BoundedStreamOutput || !this._onError)) { output.destroy(); }
    }

    private _stop(): void {
        this._closed = true;
        clearTimeout(this._timeout);
        clearInterval(this._watchdog);
        this._output?.removeListener("drain", this._drainOutput);
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
        log.info("TLVDecoder#%d has closed (stage=%s)", this._id, this._stage);
    }
}
