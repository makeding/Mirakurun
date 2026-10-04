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
import { parentPort } from "worker_threads";
// TSLint predates the node: scheme; SQLite is a Node built-in, not an npm dependency.
// tslint:disable-next-line:no-implicit-dependencies
import { DatabaseSync, SQLInputValue } from "node:sqlite";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname } from "path";
import * as apid from "../../api";
import { Program } from "./db";
import type { HistoryMutation, HistoryOptions } from "./ProgramHistory";
import sift from "sift";
import { rejectWhere } from "./common";

const DAY = 86400000;
let database: DatabaseSync;
let retentionDays: number;

class QueryError extends Error {
    status = 400;
}

function transaction<T>(fn: () => T): T {
    database.exec("BEGIN IMMEDIATE");
    try {
        const value = fn();
        database.exec("COMMIT");
        return value;
    } catch (err) {
        database.exec("ROLLBACK");
        throw err;
    }
}

function publicProgram(program: Program): apid.Program {
    return Object.fromEntries(Object.entries(program).filter(([key]) => !key.startsWith("_"))) as unknown as apid.Program;
}

function canonical(value: any): string {
    if (Array.isArray(value)) {
        return `[${value.map(canonical).join(",")}]`;
    }
    if (value !== null && typeof value === "object") {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

function validProgram(program: Program): boolean {
    return program && [program.id, program.networkId, program.serviceId, program.eventId, program.startAt, program.duration]
        .every(value => Number.isSafeInteger(value) && value >= 0) && typeof program.isFree === "boolean";
}

function writeMutation(mutation: HistoryMutation): void {
    const { program, status, observedAt, reason } = mutation;
    if (!validProgram(program)) {
        throw new Error("Invalid program supplied to history storage");
    }
    const previous = database.prepare("SELECT * FROM programs WHERE network_id=? AND service_id=? AND event_id=? ORDER BY sequence DESC LIMIT 1").get(program.networkId, program.serviceId, program.eventId);
    const publicJSON = canonical(publicProgram(program));
    let row = previous;
    // Timing corrections on a live occurrence retain identity. Ended,
    // non-overlapping occurrences are a new use of the broadcast event ID.
    const reused = previous && status === "active" && Number(previous.end_at) < observedAt &&
        program.startAt !== Number(previous.start_at) &&
        (program.startAt >= Number(previous.end_at) || program.startAt + program.duration <= Number(previous.start_at));
    if (reused && previous.status !== "archived") {
        writeMutation({ program: JSON.parse(previous.internal_json as string), status: "archived", observedAt, reason: "event-id-reused" });
    }
    if (!previous || reused) {
        const historyId = randomUUID();
        database.prepare(`INSERT INTO programs
            (history_id, program_id, network_id, service_id, event_id, start_at, end_at,
             status, recoverable, first_observed_at, last_observed_at, revision, program_json, internal_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`).run(
            historyId, program.id, program.networkId, program.serviceId, program.eventId,
            program.startAt, program.startAt + program.duration, status, mutation.recoverable ? 1 : 0,
            observedAt, observedAt, publicJSON, JSON.stringify(program));
        row = database.prepare("SELECT * FROM programs WHERE history_id = ?").get(historyId);
    }
    const changed = Number(row.revision) === 0 || row.program_json !== publicJSON || row.status !== status;
    const revision = Number(row.revision) + (changed ? 1 : 0);
    const changeType = Number(row.revision) === 0 ? "create" :
        status === "removed" ? "remove" : status === "archived" ? "archive" :
        row.status !== "active" ? "restore" : "update";
    database.prepare(`UPDATE programs SET network_id=?, service_id=?, event_id=?, start_at=?, end_at=?,
        status=?, recoverable=?, last_observed_at=?, revision=?, program_json=?, internal_json=? WHERE history_id=?`).run(
        program.networkId, program.serviceId, program.eventId, program.startAt, program.startAt + program.duration,
        status, mutation.recoverable ? 1 : 0, observedAt, revision, publicJSON, JSON.stringify(program), row.history_id);
    if (changed) {
        database.prepare(`INSERT INTO revisions (history_id, revision, observed_at, change_type, reason, program_json)
            VALUES (?, ?, ?, ?, ?, ?)`).run(row.history_id, revision, observedAt, changeType, reason || null, publicJSON);
    }
    if (status === "active") {
        database.prepare(`INSERT INTO current_programs
            (program_id, network_id, service_id, event_id, end_at, internal_json) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(program_id) DO UPDATE SET network_id=excluded.network_id,
            service_id=excluded.service_id, event_id=excluded.event_id,
            end_at=excluded.end_at, internal_json=excluded.internal_json`).run(
            program.id, program.networkId, program.serviceId, program.eventId,
            program.startAt + program.duration, JSON.stringify(program));
    } else {
        database.prepare("DELETE FROM current_programs WHERE program_id=? AND network_id=? AND service_id=? AND event_id=?")
            .run(program.id, program.networkId, program.serviceId, program.eventId);
    }
}

function cleanup(now: number): void {
    database.prepare("DELETE FROM current_programs WHERE end_at < ?").run(now - retentionDays * DAY);
    database.prepare("DELETE FROM programs WHERE end_at < ?").run(now - retentionDays * DAY);
}

function open(options: HistoryOptions): { active: Program[]; removed: Program[] } {
    retentionDays = options.retentionDays;
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > Math.floor(Number.MAX_SAFE_INTEGER / DAY)) {
        throw new Error("programHistoryRetentionDays must be a positive supported integer");
    }
    if (options.path !== ":memory:") {
        mkdirSync(dirname(options.path), { recursive: true });
    }
    database = new DatabaseSync(options.path, { timeout: 5000 });
    database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
    const schema = Number(database.prepare("PRAGMA user_version").get().user_version);
    if (schema !== 0 && schema !== 1 && schema !== 2) {
        throw new Error(`Unsupported program history schema ${schema}`);
    }
    database.exec(`CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS programs (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            history_id TEXT NOT NULL UNIQUE, program_id INTEGER NOT NULL,
            network_id INTEGER NOT NULL, service_id INTEGER NOT NULL, event_id INTEGER NOT NULL,
            start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active','archived','removed')),
            recoverable INTEGER NOT NULL DEFAULT 0,
            first_observed_at INTEGER NOT NULL, last_observed_at INTEGER NOT NULL,
            revision INTEGER NOT NULL, program_json TEXT NOT NULL, internal_json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS programs_broadcast ON programs(network_id, service_id, event_id, sequence DESC);
        CREATE INDEX IF NOT EXISTS programs_time ON programs(start_at, history_id);
        CREATE INDEX IF NOT EXISTS programs_service_time ON programs(network_id, service_id, start_at, history_id);
        CREATE INDEX IF NOT EXISTS programs_expiry ON programs(end_at);
        CREATE TABLE IF NOT EXISTS revisions (
            history_id TEXT NOT NULL REFERENCES programs(history_id) ON DELETE CASCADE,
            revision INTEGER NOT NULL, observed_at INTEGER NOT NULL,
            change_type TEXT NOT NULL, reason TEXT, program_json TEXT NOT NULL,
            PRIMARY KEY(history_id, revision));
        CREATE TABLE IF NOT EXISTS current_programs (
            position INTEGER PRIMARY KEY AUTOINCREMENT, program_id INTEGER NOT NULL UNIQUE,
            network_id INTEGER NOT NULL, service_id INTEGER NOT NULL, event_id INTEGER NOT NULL,
            end_at INTEGER NOT NULL, internal_json TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS current_programs_network ON current_programs(network_id, position);
        CREATE INDEX IF NOT EXISTS current_programs_service ON current_programs(service_id, position);
        CREATE INDEX IF NOT EXISTS current_programs_event ON current_programs(event_id, position);`);
    const now = Date.now();
    transaction(() => {
        if (schema < 2) {
            // Match the old startup Map: first insertion sets order, later IDs replace data.
            for (const row of database.prepare("SELECT * FROM programs WHERE status='active' ORDER BY sequence").all()) {
                database.prepare(`INSERT INTO current_programs
                    (program_id, network_id, service_id, event_id, end_at, internal_json) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(program_id) DO UPDATE SET network_id=excluded.network_id,
                    service_id=excluded.service_id, event_id=excluded.event_id,
                    end_at=excluded.end_at, internal_json=excluded.internal_json`).run(
                    row.program_id, row.network_id, row.service_id, row.event_id, row.end_at, row.internal_json);
            }
            database.exec("PRAGMA user_version=2");
        }
        const migrated = database.prepare("SELECT value FROM metadata WHERE key='legacy-imported'").get();
        if (!migrated) {
            if (options.legacyPath && existsSync(options.legacyPath)) {
                const contents = JSON.parse(readFileSync(options.legacyPath, "utf8"));
                if (!Array.isArray(contents)) {
                    throw new Error("Legacy program database must contain a JSON array");
                }
                const header = contents[0]?.__integrity__;
                const programs = header ? contents.slice(1) : contents;
                for (const program of programs) {
                    if (!validProgram(program)) {
                        throw new Error("Invalid record in legacy program database");
                    }
                    if (program.startAt + program.duration >= now - retentionDays * DAY) {
                        writeMutation({ program, observedAt: now, status:
                            (!header || header === options.integrity) && program.startAt + program.duration >= now ? "active" : "archived",
                            reason: "legacy-import" });
                    }
                }
            }
            database.prepare("INSERT INTO metadata VALUES ('legacy-imported','1')").run();
        }
        const integrity = database.prepare("SELECT value FROM metadata WHERE key='channels-integrity'").get();
        const changed = integrity && integrity.value !== options.integrity;
        const stale = database.prepare(`SELECT * FROM programs WHERE status='active' AND
            (end_at < ? OR ? = 1)`).all(now, changed ? 1 : 0);
        for (const row of stale) {
            writeMutation({ program: JSON.parse(row.internal_json as string), status: "archived", observedAt: now,
                reason: changed ? "channels-changed" : "startup-expired" });
        }
        if (changed) {
            database.prepare("UPDATE programs SET recoverable=0 WHERE status='removed'").run();
        }
        database.prepare("INSERT OR REPLACE INTO metadata VALUES ('channels-integrity',?)").run(options.integrity);
        cleanup(now);
    });
    const active = database.prepare("SELECT internal_json FROM current_programs ORDER BY position").all()
        .map(row => JSON.parse(row.internal_json as string));
    const removed = database.prepare("SELECT internal_json FROM programs WHERE status='removed' AND recoverable=1 AND end_at>=? AND sequence=(SELECT MAX(p.sequence) FROM programs p WHERE p.network_id=programs.network_id AND p.service_id=programs.service_id AND p.event_id=programs.event_id)").all(now - DAY)
        .map(row => JSON.parse(row.internal_json as string));
    return { active, removed };
}

function programs(query: any): string {
    rejectWhere(query);
    const filters: string[] = [];
    const values: SQLInputValue[] = [];
    const remaining = { ...query };
    for (const [field, column] of [["networkId", "network_id"], ["serviceId", "service_id"], ["eventId", "event_id"]]) {
        if (Number.isSafeInteger(query[field])) {
            filters.push(`${column}=?`);
            values.push(query[field]);
            delete remaining[field];
        }
    }
    if (Object.keys(remaining).length > 0) {
        let matches: (program: Program) => boolean;
        try {
            matches = sift(remaining);
        } catch (err) {
            throw new QueryError(err.message);
        }
        // The existing extended query contract is evaluated inside SQLite's worker.
        database.function("program_matches", (json: string) => matches(JSON.parse(json)) ? 1 : 0);
        filters.push("program_matches(internal_json)=1");
    }
    const rows = database.prepare(`SELECT internal_json FROM current_programs
        ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY position`).all(...values);
    return `[${rows.map(row => row.internal_json).join(",")}]`;
}

function item(row: any): apid.ProgramHistoryItem {
    return {
        historyId: row.history_id,
        program: JSON.parse(row.program_json),
        status: row.status,
        firstObservedAt: row.first_observed_at,
        lastObservedAt: row.last_observed_at,
        revision: row.revision
    };
}

function get(historyId: string): apid.ProgramHistoryItem | null {
    const row = database.prepare("SELECT * FROM programs WHERE history_id=? AND end_at>=?")
        .get(historyId, Date.now() - retentionDays * DAY);
    return row ? item(row) : null;
}

function integer(value: any, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
    if ((typeof value !== "number" && typeof value !== "string") ||
        (typeof value === "string" && !/^\d+$/.test(value))) {
        throw new QueryError(`Invalid ${name}`);
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0 || number > maximum) {
        throw new QueryError(`Invalid ${name}`);
    }
    return number;
}

function queryOptions(query: any, allowed: string[]): { limit: number; cursor?: string } {
    if (!query || typeof query !== "object" || Array.isArray(query) || Object.keys(query).some(key => !allowed.includes(key))) {
        throw new QueryError("Invalid history query");
    }
    const limit = query.limit === undefined ? 100 : integer(query.limit, "limit", 500);
    if (limit < 1 || (query.cursor !== undefined && (typeof query.cursor !== "string" || query.cursor.length > 2048))) {
        throw new QueryError("Invalid pagination");
    }
    return { limit, cursor: query.cursor };
}

function decodeCursor(cursor: string, binding: string): any[] {
    try {
        if (!/^[A-Za-z0-9_-]+$/.test(cursor)) {
            throw new Error("Invalid encoding");
        }
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (decoded.binding !== binding || !Array.isArray(decoded.after)) {
            throw new Error("Invalid binding");
        }
        return decoded.after;
    } catch (err) {
        throw new QueryError("Invalid cursor or cursor belongs to another query");
    }
}

function encodeCursor(binding: string, after: any[]): string {
    return Buffer.from(JSON.stringify({ binding, after })).toString("base64url");
}

function list(query: any): apid.ProgramHistoryPage {
    const { limit, cursor } = queryOptions(query, ["from", "to", "networkId", "serviceId", "eventId", "limit", "cursor"]);
    const from = integer(query.from, "from");
    const to = integer(query.to, "to");
    if (from >= to) {
        throw new QueryError("from must be before to");
    }
    const filters = ["start_at>=?", "start_at<?", "end_at>=?"];
    const values: SQLInputValue[] = [from, to, Date.now() - retentionDays * DAY];
    const normalized = { from, to };
    for (const [field, column] of [["networkId", "network_id"], ["serviceId", "service_id"], ["eventId", "event_id"]]) {
        if (query[field] !== undefined) {
            normalized[field] = integer(query[field], field, 65535);
            filters.push(`${column}=?`);
            values.push(normalized[field]);
        }
    }
    const binding = canonical(normalized);
    if (cursor) {
        const after = decodeCursor(cursor, binding);
        if (after.length !== 2 || typeof after[1] !== "string" || !/^[a-f0-9-]{36}$/.test(after[1])) {
            throw new QueryError("Invalid cursor position");
        }
        const time = integer(after[0], "cursor time");
        filters.push("(start_at>? OR (start_at=? AND history_id>?))");
        values.push(time, time, after[1]);
    }
    const rows = database.prepare(`SELECT * FROM programs WHERE ${filters.join(" AND ")}
        ORDER BY start_at,history_id LIMIT ?`).all(...values, limit + 1);
    const selected = rows.slice(0, limit);
    const last = selected[selected.length - 1];
    return { items: selected.map(item), nextCursor: rows.length > limit ? encodeCursor(binding, [last.start_at, last.history_id]) : null };
}

function revisions(historyId: string, query: any): apid.ProgramHistoryRevisionPage | null {
    const { limit, cursor } = queryOptions(query, ["limit", "cursor"]);
    const binding = `revisions:${historyId}`;
    let after = 0;
    if (cursor) {
        const position = decodeCursor(cursor, binding);
        if (position.length !== 1) {
            throw new QueryError("Invalid revision cursor");
        }
        after = integer(position[0], "cursor revision");
    }
    if (!get(historyId)) {
        return null;
    }
    const rows = database.prepare("SELECT * FROM revisions WHERE history_id=? AND revision>? ORDER BY revision LIMIT ?")
        .all(historyId, after, limit + 1);
    const items: apid.ProgramHistoryRevision[] = rows.slice(0, limit).map(row => ({
        historyId, revision: Number(row.revision), observedAt: Number(row.observed_at),
        changeType: row.change_type as apid.ProgramHistoryRevision["changeType"],
        ...(row.reason ? { reason: row.reason as string } : {}), program: JSON.parse(row.program_json as string)
    }));
    return { items, nextCursor: rows.length > limit ? encodeCursor(binding, [items[items.length - 1].revision]) : null };
}

parentPort.on("message", ({ id, method, data }) => {
    try {
        let result: any;
        switch (method) {
            case "open": result = open(data); break;
            case "write": result = transaction(() => { for (const mutation of data) { writeMutation(mutation); } }); break;
            case "cleanup": result = transaction(() => cleanup(data)); break;
            case "list": result = list(data); break;
            case "programs": result = programs(data); break;
            case "get": result = get(data); break;
            case "revisions": result = revisions(data.historyId, data.query); break;
            case "response": {
                const value = data.method === "list" ? list(data.data) : data.method === "get" ? get(data.data) :
                    revisions(data.data.historyId, data.data.query);
                result = value === null ? null : JSON.stringify(value);
                break;
            }
            case "close": database?.close(); break;
            default: throw new Error(`Unknown history operation ${method}`);
        }
        parentPort.postMessage({ id, result });
    } catch (err) {
        parentPort.postMessage({ id, error: { message: err.message, status: err.status || 503 } });
    }
});
