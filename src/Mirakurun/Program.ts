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
import sift from "sift";
import { dirname, join } from "path";
import { HistoryError, ProgramHistory } from "./ProgramHistory";
import * as common from "./common";
import * as log from "./log";
import * as db from "./db";
import * as apid from "../../api";
import _ from "./_";
import Event from "./Event";
import { JobItem } from "./Job";

export function getProgramItemId(networkId: number, serviceId: number, eventId: number): number {
    return parseInt(`${networkId}${serviceId.toString(10).padStart(5, "0")}${eventId.toString(10).padStart(5, "0")}`, 10);
}

function isExpiredProgram(program: Pick<db.Program, "startAt" | "duration">, now = Date.now()): boolean {
    return program.startAt + program.duration < now - (program.duration === 1 ? 86400000 : 10800000);
}

export class Program {
    private _itemMap = new Map<number, db.Program>();
    private _itemMapDeleted = new Map<number, db.Program>();
    private _history?: ProgramHistory;
    private _loaded = false;
    private _closed = false;
    private _storageFailure?: Error;
    private _memoryOnly: boolean;
    private _emitTimerId: NodeJS.Timeout;
    private _emitRunning = false;
    private _emitPrograms = new Map<db.Program, apid.EventType>();

    constructor(private _options: { memoryOnly?: boolean; onStorageFailure?: (error: Error) => void } = {}) {
        this._memoryOnly = _options.memoryOnly === true;
        if (this._memoryOnly) {
            return;
        }
        const gcJob: JobItem = {
            key: "Program.GC",
            name: "Program GC",
            fn: () => this._gc()
        };

        _.job.add({
            ...gcJob,
            readyFn: async () => {
                await common.sleep(1000 * 5);
                return this._loaded;
            }
        });

        _.job.addSchedule({
            key: "Program.GC",
            schedule: _.config.server.programGCJobSchedule || "45 * * * *",
            job: gcJob
        });
    }

    get history(): ProgramHistory {
        if (!this._history) {
            throw new HistoryError("Program history is not available");
        }
        return this._history;
    }

    get itemMap(): Map<number, db.Program> {
        return this._itemMap;
    }

    add(item: db.Program, firstAdd: boolean = false): void {
        if (!firstAdd) {
            this._assertWritable();
            if (isExpiredProgram(item)) {
                this._record(item, "archived", "gc");
                return;
            }
            this.prepareEvent(item.id, item.startAt, item.duration);
        }
        if (this.exists(item.id)) {
            return;
        }

        // purge logically deleted item
        this._itemMapDeleted.delete(item.id);

        if (firstAdd === false) {
            this._findAndRemoveConflicts(item);
        }

        this._itemMap.set(item.id, item);

        if (firstAdd === false) {
            this._emitPrograms.set(item, "create");
        }

        if (!firstAdd) {
            this._record(item, "active");
            this.save();
        }
    }

    get(id: number): db.Program | null {
        return this._itemMap.get(id) || null;
    }

    set(id: number, props: Partial<db.Program>): void {
        this._assertWritable();
        let item = this.get(id);
        const candidate = item || this._itemMapDeleted.get(id);
        if (candidate && isExpiredProgram({ ...candidate, ...props })) {
            this._record({ ...candidate, ...props }, "archived", "gc");
            this._itemMap.delete(id);
            this._itemMapDeleted.delete(id);
            this.save();
            return;
        }
        if (!item) {
            // Recovers logically deleted item if that is exsts into the tempolally collection.
            item = this._itemMapDeleted.get(id) || null;
            if (item) {
                this._itemMap.set(item.id, item);
                this._itemMapDeleted.delete(item.id);
                this._emitPrograms.set(item, "create");
                this._record(item, "active", "overlap-recovered");
                this.save();

                log.debug(
                    "ProgramItem#%d (networkId=%d, serviceId=%d, eventId=%d) has recovered from the logically-deleted store",
                    item.id, item.networkId, item.serviceId, item.eventId
                );
            }
        }
        if (item && common.updateObject(item, props) === true) {
            if (props.startAt || props.duration) {
                this._findAndRemoveConflicts(item);
            }
            this._emitPrograms.set(item, "update");
            this._record(item, "active");
            this.save();
        }
    }

    remove(id: number, logicallyDelete: boolean = false, reason = "removed"): void {
        this._assertWritable();
        const existing = this.get(id);
        if (logicallyDelete) {
            const item = this.get(id);
            if (item) {
                this._itemMapDeleted.set(item.id, item);
                this._itemMap.delete(id);
                this._record(item, "removed", "overlap", true);
                this.save();
            }
        } else {
            if (this._itemMap.delete(id)) {
                this._record(existing, reason === "gc" || reason === "event-id-reused" ? "archived" : "removed", reason);
                this.save();
            }
        }
    }

    /** Reset parser state when an event ID is reused, without using startAt as identity. */
    prepareEvent(id: number, startAt: number, duration: number): boolean {
        const old = this.get(id) || this._itemMapDeleted.get(id);
        const reused = old && old.startAt + old.duration < Date.now() && old.startAt !== startAt &&
            (startAt >= old.startAt + old.duration || startAt + duration <= old.startAt);
        if (reused) {
            this.remove(id, false, "event-id-reused");
            this._itemMapDeleted.delete(id);
        }
        return !old || !!reused;
    }

    exists(id: number): boolean {
        return this._itemMap.has(id);
    }

    isLogicallyDeleted(id: number): boolean {
        return this._itemMapDeleted.has(id);
    }

    findByQuery(query: object): db.Program[] {
        common.rejectWhere(query);
        return Array.from(this._itemMap.values()).filter(sift(query));
    }

    findByNetworkId(networkId: number): db.Program[] {
        const items = [];

        for (const item of this._itemMap.values()) {
            if (item.networkId === networkId) {
                items.push(item);
            }
        }

        return items;
    }

    findByNetworkIdServiceId(networkId: number, serviceId: number): db.Program[] {
        const items = [];

        for (const item of this._itemMap.values()) {
            if (item.networkId === networkId && item.serviceId === serviceId) {
                items.push(item);
            }
        }

        return items;
    }

    findByNetworkIdAndTime(networkId: number, time: number): db.Program[] {
        const items = [];

        for (const item of this._itemMap.values()) {
            if (item.networkId === networkId && item.startAt <= time && item.startAt + item.duration > time) {
                items.push(item);
            }
        }

        return items;
    }

    findByNetworkIdAndServiceIdAndTime(networkId: number, serviceId: number, time: number): db.Program[] {
        const items = [];

        for (const item of this._itemMap.values()) {
            if (item.networkId === networkId && item.serviceId === serviceId && item.startAt <= time && item.startAt + item.duration > time) {
                items.push(item);
            }
        }

        return items;
    }

    findByNetworkIdAndReplace(networkId: number, programs: db.Program[]): void {
        this._assertWritable();
        let count = 0;
        const programIds = new Set(programs.map(program => program.id));

        for (const item of [...this._itemMap.values()].reverse()) {
            if (item.networkId === networkId && programIds.has(item.id) === false) {
                // Calling `this.remove(item)` here is safe.  Because that never
                // changes the Array object we're iterating here.
                this.remove(item.id, false, "remote-replaced");
                Event.emit("program", "remove", { id: item.id });
                --count;
            }
        }

        for (const program of programs) {
            if (isExpiredProgram(program)) {
                if (this.exists(program.id)) {
                    this.remove(program.id, false, "gc");
                }
                this._record(program, "archived", "gc");
                continue;
            }
            this.prepareEvent(program.id, program.startAt, program.duration);
            const item = this.get(program.id);
            if (item === null) {
                this.add(program);
                ++count;
            } else if (JSON.stringify(item) !== JSON.stringify(program)) {
                this._itemMap.set(program.id, program);
                this._emitPrograms.set(program, "update");
                this._record(program, "active", "remote-update");
                ++count;
            }
        }

        log.debug("programs replaced (networkId=%d, count=%d)", networkId, count);

        this.save();
    }

    save(): void {
        clearTimeout(this._emitTimerId);
        this._emitTimerId = setTimeout(() => this._emit(), 1000);
    }

    async load(): Promise<void> {
        if (this._memoryOnly || this._loaded) {
            return;
        }
        this._history = new ProgramHistory({
            path: process.env.PROGRAM_HISTORY_DB_PATH || join(dirname(process.env.PROGRAMS_DB_PATH || "/usr/local/var/db/mirakurun/programs.json"), "programs.sqlite"),
            legacyPath: process.env.PROGRAMS_DB_PATH,
            integrity: _.configIntegrity.channels,
            retentionDays: _.config.server.programHistoryRetentionDays || 365,
            onFailure: err => {
                this._storageFailure = err;
                log.fatal("%s", err.stack || err);
                _.job?.close();
                this._options.onStorageFailure?.(err);
            }
        });
        const programs = await this._history.open();
        for (const item of programs.active) {
            this.add(item, true);
        }
        for (const item of programs.removed) {
            if (!this._itemMap.has(item.id)) {
                this._itemMapDeleted.set(item.id, item);
            }
        }
        this._loaded = true;
        await this._gc();
    }

    async close(): Promise<void> {
        this._closed = true;
        clearTimeout(this._emitTimerId);
        await this._history?.close();
    }

    private _assertWritable(): void {
        if (this._closed || this._storageFailure || (this._memoryOnly === false && !this._loaded)) {
            throw this._storageFailure || new HistoryError("Program store is not accepting updates");
        }
        this._history?.assertWritable();
    }

    private _record(program: db.Program, status: "active" | "archived" | "removed", reason?: string, recoverable = false): void {
        this._history?.record({ program, status, reason, recoverable, observedAt: Date.now() });
    }

    private _findAndRemoveConflicts(added: db.Program): void {
        const addedEndAt = added.startAt + added.duration;

        for (const item of this._itemMap.values()) {
            if (
                item.networkId === added.networkId &&
                item.serviceId === added.serviceId &&
                item.id !== added.id
            ) {
                const itemEndAt = item.startAt + item.duration;
                if ((
                        (added.startAt <= item.startAt && item.startAt < addedEndAt) ||
                        (item.startAt <= added.startAt && added.startAt < itemEndAt)
                    ) &&
                    (!(item._isPresent || item._isFollowing) || added._isPresent)
                ) {
                    this.remove(item.id, true);
                    Event.emit("program", "remove", { id: item.id });

                    log.debug(
                        "ProgramItem#%d (networkId=%d, serviceId=%d, eventId=%d) has removed by overlapped ProgramItem#%d (eventId=%d)",
                        item.id, item.networkId, item.serviceId, item.eventId, added.id, added.eventId
                    );
                }
            }
        }
    }

    private async _emit(): Promise<void> {
        if (this._emitRunning) {
            return;
        }
        this._emitRunning = true;

        for (const [item, eventType] of this._emitPrograms) {
            this._emitPrograms.delete(item);
            Event.emit("program", eventType, item);

            await common.sleep(10);
        }

        this._emitRunning = false;
        if (this._emitPrograms.size > 0) {
            this._emit();
        }
    }

    private async _gc(): Promise<void> {
        if (!this._loaded || this._closed) {
            return;
        }
        this._assertWritable();
        log.debug("Program GC has started");

        const maximum = Date.now() + 1000 * 60 * 60 * 24 * 9; // 9 days
        let count = 0;

        for (const item of this._itemMap.values()) {
            if (
                isExpiredProgram(item) ||
                maximum < item.startAt
            ) {
                ++count;
                this.remove(item.id, false, "gc");
            }
        }

        // Perform GC for the logically-deleted store
        for (const item of this._itemMapDeleted.values()) {
            if (
                isExpiredProgram(item) ||
                maximum < item.startAt
            ) {
                ++count;
                this._itemMapDeleted.delete(item.id);
                this._record(item, "archived", "gc");
            }
        }

        await this._history?.cleanup();
        log.info("Program GC has finished and removed %d programs", count);
    }
}

export default Program;
