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
import { randomUUID } from "crypto";
import { StreamFailure, TLVStreamProtection } from "../../api";

export const protectionDefaults: Required<TLVStreamProtection> = {
    maxBufferBytes: 32 * 1024 * 1024,
    startupTimeoutMs: 10000,
    sourceTimeoutMs: 30000,
    stallTimeoutMs: 15000,
    outputTimeoutMs: 30000,
    drainTimeoutMs: 10000
};

export function streamProtection(value?: TLVStreamProtection): Required<TLVStreamProtection> {
    const result = { ...protectionDefaults };
    for (const key of Object.keys(result) as Array<keyof TLVStreamProtection>) {
        if (Number.isSafeInteger(value?.[key]) && value[key] > 0) { result[key] = value[key]; }
    }
    return result;
}

export function redactStreamText(value: string): string {
    return value.replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]")
        .replace(/(\b[\w-]*(?:secret|password|token|authorization|api[_-]?key)[\w-]*[\s=:]+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
        .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]");
}

export class StreamStageError extends Error {
    constructor(readonly detail: Omit<StreamFailure, "id" | "at" | "channel">) {
        super(detail.reason);
    }
}

class StreamFailureStore {
    private readonly records: StreamFailure[] = [];
    add(context: { requestId?: string; channel: string; serviceId?: number }, error: Error): void {
        const detail = error instanceof StreamStageError ? error.detail : {
            stage: "pipeline", code: "STREAM_FAILED", reason: "The stream pipeline failed.",
            inputBytes: 0, outputBytes: 0, stderr: ""
        };
        this.records.unshift({ ...detail, ...context, id: randomUUID(), at: Date.now(),
            stderr: redactStreamText(detail.stderr).slice(-4096) });
        this.records.length = Math.min(this.records.length, 50);
    }
    list(): StreamFailure[] { return this.records.map(record => ({ ...record })); }
}

export const streamFailures = new StreamFailureStore();

/** Shared only by the stages belonging to one request, never by tuner users. */
export class StreamByteBudget {
    pending = 0;
    constructor(readonly limit: number) {}
    reserve(bytes: number): boolean {
        if (bytes > this.limit - this.pending) { return false; }
        this.pending += bytes;
        return true;
    }
    release(bytes: number): void { this.pending -= bytes; }
}
