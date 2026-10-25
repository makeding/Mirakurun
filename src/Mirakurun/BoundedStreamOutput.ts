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
import { Writable } from "stream";
import { TLVStreamProtection } from "../../api";
import { StreamByteBudget, StreamStageError } from "./StreamFailure";

/** Final per-request queue. A blocked client cannot grow other users' queues. */
export default class BoundedStreamOutput extends Writable {
    private inputBytes = 0;
    private outputBytes = 0;
    private lastInputAt: number;
    private lastOutputAt: number;
    private pendingSince: number;
    private endingAt: number;
    private pendingWrite: (() => void) | undefined;
    private readonly timer: NodeJS.Timeout;
    private readonly onClosed: () => void;
    private readonly onErrored: () => void;

    constructor(private readonly output: Writable, private readonly budget: StreamByteBudget,
                private readonly protection: Required<TLVStreamProtection>, private readonly onFailure: (error: Error) => void) {
        super({ highWaterMark: Math.min(64 * 1024, protection.maxBufferBytes) });
        this.onClosed = () => { this.destroy(); };
        this.onErrored = () => this.fail("OUTPUT_FAILED", "The stream consumer disconnected with an error.");
        output.once("close", this.onClosed);
        output.once("error", this.onErrored);
        this.on("error", this.onErrored);
        this.timer = setInterval(() => {
            if (this.pendingSince && Date.now() - this.pendingSince >= protection.outputTimeoutMs) {
                this.fail("OUTPUT_STALLED", "The client stopped accepting stream data.");
            } else if (this.endingAt && Date.now() - this.endingAt >= protection.drainTimeoutMs) {
                this.fail("DRAIN_TIMEOUT", "The output did not finish after the stream ended.");
            }
        }, Math.max(10, Math.min(250, protection.outputTimeoutMs / 4, protection.drainTimeoutMs / 4)));
        this.timer.unref();
    }

    write(chunk: any, encoding?: any, callback?: any): boolean {
        const cb = typeof encoding === "function" ? encoding : callback;
        if (this.destroyed) { cb?.(); return false; }
        const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, typeof encoding === "string" ? encoding as BufferEncoding : undefined);
        if (!this.budget.reserve(bytes)) {
            this.fail("BUFFER_LIMIT", "The stream consumer cannot keep up with the broadcast.");
            cb?.();
            return false;
        }
        this.inputBytes += bytes;
        this.lastInputAt = Date.now();
        return super.write(chunk, typeof encoding === "string" ? encoding as BufferEncoding : undefined, error => {
            this.budget.release(bytes);
            cb?.(this.destroyed ? undefined : error);
        });
    }

    end(chunk?: any, encoding?: any, callback?: any): this {
        this.endingAt ||= Date.now();
        const cb = typeof chunk === "function" ? chunk : typeof encoding === "function" ? encoding : callback;
        if (chunk !== null && chunk !== undefined && typeof chunk !== "function") { this.write(chunk, typeof encoding === "string" ? encoding : undefined); }
        return super.end(cb);
    }

    _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
        this.pendingSince = Date.now();
        let settled = false;
        const finish = () => {
            if (settled) { return; }
            settled = true;
            this.pendingWrite = undefined;
            this.pendingSince = undefined;
            callback();
        };
        this.pendingWrite = finish;
        this.output.write(chunk, error => {
            if (settled) { return; }
            this.pendingSince = undefined;
            if (error && !this.destroyed) { this.onErrored(); }
            if (!error) { this.outputBytes += chunk.length; this.lastOutputAt = Date.now(); }
            finish();
        });
    }
    _final(callback: (error?: Error | null) => void): void {
        if (this.output.destroyed) { callback(); return; }
        this.output.end(callback);
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        clearInterval(this.timer);
        this.pendingWrite?.();
        this.output.removeListener("close", this.onClosed);
        this.output.removeListener("error", this.onErrored);
        callback(error);
    }
    private fail(code: string, reason: string): void {
        if (this.destroyed) { return; }
        this.onFailure(new StreamStageError({ stage: "output", code, reason, inputBytes: this.inputBytes,
            outputBytes: this.outputBytes, lastInputAt: this.lastInputAt, lastOutputAt: this.lastOutputAt, stderr: "" }));
        this.destroy();
    }
}
