/*
   Copyright 2016 kanreisa

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
import { performance } from "perf_hooks";
import { setImmediate as yieldImmediate } from "timers/promises";
import sift from "sift";
import * as apid from "../../api";
import { deepClone, rejectWhere } from "./common";
import * as log from "./log";

const REFRESH_INTERVAL_MS = 30000;
const BATCH_CHARACTERS = 64 * 1024;

interface Snapshot {
    programs: apid.Program[];
    json: Buffer;
    capturedAt: number;
}

/** Serialize independent program data without shared serializer state. */
export async function serializePrograms(programs: apid.Program[]): Promise<Buffer> {
    const chunks: Buffer[] = [Buffer.from("[")];
    let batch: string[] = [];
    let characters = 0;
    let firstBatch = true;

    for (const program of programs) {
        const json = JSON.stringify(program);
        batch.push(json);
        characters += json.length + 1;
        if (characters >= BATCH_CHARACTERS) {
            chunks.push(Buffer.from((firstBatch ? "" : ",") + batch.join(",")));
            firstBatch = false;
            batch = [];
            characters = 0;
            await yieldImmediate();
        }
    }

    if (batch.length > 0) {
        chunks.push(Buffer.from((firstBatch ? "" : ",") + batch.join(",")));
    }
    chunks.push(Buffer.from("]"));
    return Buffer.concat(chunks);
}

/** Owned by one program store; only complete snapshots are published. */
export class ProgramSnapshot {
    private _current?: Snapshot;
    private _refreshing?: Promise<void>;
    private _timer?: NodeJS.Timeout;
    private _lifecycle = 0;

    constructor(private _programs: () => Iterable<apid.Program>) {}

    async start(): Promise<void> {
        const lifecycle = this._lifecycle;
        await this.refresh();
        if (lifecycle === this._lifecycle && !this._timer) {
            this._timer = setInterval(() => {
                this.refresh().catch(err => {
                    const age = this._current ? Date.now() - this._current.capturedAt : null;
                    log.error("Program snapshot refresh failed (snapshotAgeMs=%s): %s", age, err.stack || err);
                });
            }, REFRESH_INTERVAL_MS);
            this._timer.unref();
        }
    }

    async stop(): Promise<void> {
        ++this._lifecycle;
        clearInterval(this._timer);
        this._timer = undefined;
        try {
            await this._refreshing;
        } catch (err) {
            log.error("Program snapshot stopped after refresh failure: %s", err.stack || err);
        } finally {
            this._current = undefined;
        }
    }

    refresh(): Promise<void> {
        if (!this._refreshing) {
            this._refreshing = this._build().finally(() => {
                this._refreshing = undefined;
            });
        }
        return this._refreshing;
    }

    async getResponse(query: object): Promise<Buffer> {
        rejectWhere(query);
        const snapshot = this._current;
        if (!snapshot) {
            throw new Error("Program snapshot is not ready");
        }
        if (Object.keys(query).length === 0) {
            return snapshot.json;
        }
        return serializePrograms(snapshot.programs.filter(sift(query)));
    }

    private async _build(): Promise<void> {
        const started = performance.now();
        const capturedAt = Date.now();
        // No await before this copy: EPG writers cannot interleave with capture.
        const programs: apid.Program[] = deepClone(Array.from(this._programs()));
        const json = await serializePrograms(programs);
        this._current = { programs, json, capturedAt };
        log.info("Program snapshot ready (programs=%d, bytes=%d, durationMs=%d)",
            programs.length, json.length, Math.round(performance.now() - started));
    }
}
