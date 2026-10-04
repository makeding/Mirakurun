/*
   Copyright 2026 huggy

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
import { Worker } from "worker_threads";
import { join } from "path";
import * as apid from "../../api";
import { Program } from "./db";
import { rejectWhere } from "./common";

export interface HistoryMutation {
    program: Program;
    status: "active" | "archived" | "removed";
    observedAt: number;
    reason?: string;
    recoverable?: boolean;
}

export interface HistoryOptions {
    path: string;
    legacyPath?: string;
    integrity: string;
    retentionDays: number;
    onFailure?: (error: Error) => void;
}

export interface HistoryLoad {
    active: Program[];
    removed: Program[];
}

export class HistoryError extends Error {
    constructor(message: string, readonly status = 503) {
        super(message);
    }
}

/** One worker owns SQLite. Mutation payloads are copied at the writer boundary. */
export class ProgramHistory {
    private _worker?: Worker;
    private _nextId = 0;
    private _pending = new Map<number, { resolve: (value: any) => void; reject: (err: Error) => void }>();
    private _queue: HistoryMutation[] = [];
    private _queuedBytes = 0;
    private _timer?: NodeJS.Timeout;
    private _writes: Promise<void> = Promise.resolve();
    private _failure?: HistoryError;
    private _closing = false;

    constructor(private _options: HistoryOptions) {}

    async open(): Promise<HistoryLoad> {
        if (this._worker) {
            throw new Error("Program history is already open");
        }
        this._worker = new Worker(join(__dirname, "ProgramHistoryWorker.js"));
        this._worker.on("message", message => {
            const pending = this._pending.get(message.id);
            if (!pending) {
                return;
            }
            this._pending.delete(message.id);
            if (message.error) {
                const error = new HistoryError(message.error.message, message.error.status);
                pending.reject(error);
                if (error.status !== 400) {
                    this._fail(error);
                }
            } else {
                pending.resolve(message.result);
            }
        });
        this._worker.on("error", err => this._fail(err));
        this._worker.on("exit", code => {
            if (!this._closing || this._pending.size > 0) {
                this._fail(new Error(`Program history worker exited (${code})`));
            }
        });
        try {
            return await this._request("open", this._options);
        } catch (err) {
            this._fail(err);
            await this.close().catch(() => undefined);
            throw err;
        }
    }

    assertWritable(): void {
        if (this._failure) {
            throw this._failure;
        }
        if (!this._worker || this._closing) {
            throw new HistoryError("Program history is not available");
        }
    }

    record(mutation: HistoryMutation): void {
        this.assertWritable();
        const json = JSON.stringify(mutation);
        const bytes = Buffer.byteLength(json);
        // Includes in-flight batches, not just the unsent queue.
        if (this._queuedBytes + bytes > 64 * 1024 * 1024) {
            this._fail(new Error("Program history write backlog exceeded 64 MiB"));
            throw this._failure;
        }
        this._queuedBytes += bytes;
        this._queue.push(JSON.parse(json));
        if (!this._timer) {
            this._timer = setTimeout(() => {
                this.flush().catch(err => this._fail(err));
            }, 50);
        }
    }

    async flush(): Promise<void> {
        clearTimeout(this._timer);
        this._timer = undefined;
        this.assertWritable();
        if (this._queue.length > 0) {
            const batch = this._queue;
            const bytes = Buffer.byteLength(JSON.stringify(batch)) - batch.length - 1;
            this._queue = [];
            this._writes = this._writes.then(async () => {
                await this._request("write", batch);
                this._queuedBytes -= bytes;
            });
            // Register immediately: a failed timer batch must never be unhandled.
            this._writes.catch(err => this._fail(err));
        }
        await this._writes;
    }

    async cleanup(now = Date.now()): Promise<void> {
        await this.flush();
        await this._request("cleanup", now);
    }

    async list(query: object): Promise<apid.ProgramHistoryPage> {
        await this.flush();
        return this._request("list", query);
    }

    /** Query current persisted programs; no response cache or main-thread filtering. */
    async programs(query: object): Promise<string> {
        rejectWhere(query);
        await this.flush();
        return this._request("programs", query);
    }

    async get(historyId: string): Promise<apid.ProgramHistoryItem | null> {
        await this.flush();
        return this._request("get", historyId);
    }

    async revisions(historyId: string, query: object): Promise<apid.ProgramHistoryRevisionPage | null> {
        await this.flush();
        return this._request("revisions", { historyId, query });
    }

    /** Serialize pages in the owning worker, independent of global JSON serializers. */
    async response(method: "list" | "get" | "revisions", data: any): Promise<string | null> {
        await this.flush();
        return this._request("response", { method, data });
    }

    async close(): Promise<void> {
        if (!this._worker || this._closing) {
            return;
        }
        clearTimeout(this._timer);
        try {
            if (!this._failure) {
                await this.flush();
                await this._request("close");
            }
        } finally {
            this._closing = true;
            await this._worker.terminate();
            this._worker = undefined;
        }
    }

    private _request(method: string, data?: any): Promise<any> {
        this.assertWritable();
        const id = ++this._nextId;
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            // Functions cannot cross the worker boundary.
            const payload = method === "open" ? { ...data, onFailure: undefined } : data;
            try {
                this._worker.postMessage({ id, method, data: payload });
            } catch (err) {
                this._pending.delete(id);
                reject(err);
            }
        });
    }

    private _fail(error: Error): void {
        if (this._failure) {
            return;
        }
        this._failure = new HistoryError(`Program history storage failed: ${error.message}`);
        clearTimeout(this._timer);
        for (const pending of this._pending.values()) {
            pending.reject(this._failure);
        }
        this._pending.clear();
        this._options.onFailure?.(this._failure);
    }
}
