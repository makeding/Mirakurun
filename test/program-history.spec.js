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
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const { writeFileSync, readFileSync, existsSync, unlinkSync, statSync } = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { randomUUID } = require("node:crypto");
const { ProgramHistory: BaseHistory } = require("../lib/Mirakurun/ProgramHistory");
const { Program, getProgramItemId } = require("../lib/Mirakurun/Program");
const Event = require("../lib/Mirakurun/Event").default;
const _ = require("../lib/Mirakurun/_").default;

const fileResources = new Map();
class ProgramHistory extends BaseHistory {
    constructor(options) {
        super(options);
        fileResources.get(options.path)?.push(this);
    }
}

const DAY = 86400000;
function program(eventId = 1, startAt = Date.now() + DAY) {
    return {
        id: getProgramItemId(1, 1, eventId), networkId: 1, serviceId: 1, eventId,
        startAt, duration: 3600000, isFree: true, name: "番組", description: "説明",
        extended: { 内容: "詳細" }, genres: [{ lv1: 7, lv2: 0 }],
        video: { type: "h.264", resolution: "1080i" },
        series: { id: 1, repeat: 0, pattern: 1, expiresAt: startAt + DAY, episode: 1, lastEpisode: 12 },
        relatedItems: [{ type: "shared", networkId: 1, serviceId: 2, eventId: 1 }]
    };
}

async function memory(t, options = {}) {
    const history = new ProgramHistory({ path: ":memory:", integrity: "test", retentionDays: 365, ...options });
    t.after(() => history.close());
    await history.open();
    return history;
}

function observe(history, data, status = "active", observedAt = Date.now(), reason, recoverable) {
    history.record({ program: data, status, observedAt, reason, recoverable });
}

function range(from = Date.now() - 365 * DAY, to = Date.now() + 10 * DAY) {
    return { from, to };
}

// Existing project test-output directory. Exact owned files, 64 MiB total
// budget; teardown runs on success/failure and startup removes these stale files.
function files(t, name) {
    const path = join(__dirname, "tmp", `program-history-${name}.sqlite`);
    const legacyPath = join(__dirname, "tmp", `program-history-${name}.json`);
    const owned = [path, `${path}-wal`, `${path}-shm`, legacyPath];
    const cleanup = () => {
        let total = 0;
        for (const file of owned) {
            if (existsSync(file)) {
                total += statSync(file).size;
                unlinkSync(file);
            }
        }
        assert.ok(total < 64 * 1024 * 1024, "history test-output budget");
        assert.ok(owned.every(file => !existsSync(file)), "owned outputs removed");
    };
    cleanup();
    const resources = [];
    fileResources.set(path, resources);
    t.after(async () => {
        for (const resource of resources) { await resource.close(); }
        cleanup();
        fileResources.delete(path);
    });
    return { path, legacyPath, integrity: "test", retentionDays: 365 };
}

function install(t, options) {
    const previous = { ..._, config: _.config.server, integrity: _.configIntegrity.channels };
    const oldEnv = [process.env.PROGRAMS_DB_PATH, process.env.PROGRAM_HISTORY_DB_PATH];
    _.config.server = { programHistoryRetentionDays: 365 };
    _.configIntegrity.channels = "test";
    _.event = new Event();
    _.job = { add() {}, addSchedule() {}, close() {} };
    process.env.PROGRAMS_DB_PATH = options.legacyPath;
    process.env.PROGRAM_HISTORY_DB_PATH = options.path;
    const store = new Program();
    fileResources.get(options.path)?.push(store);
    _.program = store;
    t.after(async () => {
        await store.close();
        for (const key of ["program", "job", "event", "server", "tuner", "service", "channel"]) { _[key] = previous[key]; }
        _.config.server = previous.config;
        _.configIntegrity.channels = previous.integrity;
        for (const [i, key] of ["PROGRAMS_DB_PATH", "PROGRAM_HISTORY_DB_PATH"].entries()) {
            if (oldEnv[i] === undefined) { delete process.env[key]; } else { process.env[key] = oldEnv[i]; }
        }
    });
    return store;
}

describe("[program-history.spec] immutable versions and identity", () => {
    it("keys history by channel and event, including when a provider ID collides", async t => {
        const history = await memory(t);
        const first = program();
        const other = { ...first, networkId: 2, name: "other channel" };
        observe(history, first);
        observe(history, other);
        const items = (await history.list(range())).items;
        assert.equal(items.length, 2);
        assert.notEqual(items[0].historyId, items[1].historyId);
        observe(history, { ...other, name: "updated other channel" });
        const updated = (await history.list(range())).items;
        assert.equal(updated.find(item => item.program.networkId === 1).revision, 1);
        assert.equal(updated.find(item => item.program.networkId === 2).revision, 2);
    });
    it("persists every intermediate public change, deduplicates identical content and stores internal flags separately", async t => {
        const history = await memory(t);
        const data = program();
        observe(history, data);
        data.name = "改名";
        observe(history, data);
        data.extended.内容 = "新しい内容";
        observe(history, data);
        observe(history, { ...data, _isPresent: true });
        observe(history, { ...data, _isPresent: true });
        const page = await history.list(range());
        assert.equal(page.items.length, 1);
        const current = page.items[0];
        assert.equal(current.revision, 3);
        assert.deepEqual(current.program, data);
        assert.ok(!("_isPresent" in current.program));
        const versions = await history.revisions(current.historyId, {});
        assert.deepEqual(versions.items.map(item => item.program.name), ["番組", "改名", "改名"]);
        assert.deepEqual(versions.items.map(item => item.program.extended.内容), ["詳細", "詳細", "新しい内容"]);
        assert.deepEqual(versions.items.map(item => item.changeType), ["create", "update", "update"]);
    });

    it("keeps live timing corrections together and separates an ended non-overlapping reused event", async t => {
        const history = await memory(t);
        const now = Date.now();
        const data = program(1, now - 60000);
        observe(history, data, "active", now);
        const original = (await history.list(range())).items[0].historyId;
        data.startAt += 600000;
        observe(history, data, "active", now + 1000);
        assert.equal((await history.list(range())).items[0].historyId, original);
        data.startAt += 3 * DAY;
        observe(history, data, "active", now + 2 * DAY);
        const items = (await history.list(range())).items;
        assert.equal(items.length, 2);
        assert.equal(items[0].historyId, original);
        assert.equal(items[0].status, "archived");
        assert.equal(items[1].status, "active");
        assert.notEqual(items[1].historyId, original);
        assert.equal((await history.revisions(original, {})).items.at(-1).reason, "event-id-reused");
    });

    it("preserves removals and recoveries as explicit versions", async t => {
        const history = await memory(t);
        const data = program();
        observe(history, data);
        observe(history, data, "removed", Date.now(), "overlap", true);
        observe(history, data, "active", Date.now(), "overlap-recovered");
        observe(history, data, "archived", Date.now(), "gc");
        const item = (await history.list(range())).items[0];
        const versions = (await history.revisions(item.historyId, {})).items;
        assert.deepEqual(versions.map(value => value.changeType), ["create", "remove", "restore", "archive"]);
        assert.equal(item.status, "archived");
        assert.deepEqual(versions.map(value => value.program), [data, data, data, data]);
    });

    it("binds cursors to filters and history IDs, validates limits and uses latest schedule time", async t => {
        const history = await memory(t);
        const first = program(1);
        for (let id = 1; id <= 3; ++id) { observe(history, program(id, first.startAt)); }
        const query = { from: first.startAt, to: first.startAt + DAY, limit: 1 };
        const page = await history.list(query);
        assert.ok(page.nextCursor);
        const next = await history.list({ ...query, cursor: page.nextCursor });
        assert.notEqual(next.items[0].historyId, page.items[0].historyId);
        await assert.rejects(history.list({ ...query, serviceId: 2, cursor: page.nextCursor }), { status: 400 });
        for (const invalid of [{}, { from: 0, to: 0 }, { ...query, limit: 0 }, { ...query, limit: 501 },
            { ...query, from: "NaN" }, { ...query, eventId: 65536 }, { ...query, cursor: "bad" }, { ...query, unknown: 1 }]) {
            await assert.rejects(history.list(invalid), { status: 400 });
        }
        first.startAt -= DAY;
        observe(history, first);
        assert.equal((await history.list(query)).items[0].program.eventId !== 1, true);
        const one = await history.get(page.items[0].historyId);
        observe(history, { ...one.program, name: "version2" });
        const versions = await history.revisions(one.historyId, { limit: 1 });
        assert.ok(versions.nextCursor);
        const more = await history.revisions(one.historyId, { cursor: versions.nextCursor });
        assert.equal(more.items[0].revision, 2);
        await assert.rejects(history.revisions(randomUUID(), { cursor: versions.nextCursor }), { status: 400 });
        assert.equal(await history.get(randomUUID()), null);
    });
});

describe("[program-history.spec] migration, restart, retention and failure", () => {
    it("imports JSON once before readers, keeps ended programs in history and restores removed entries", async t => {
        const options = files(t, "restart");
        const current = program(1);
        const ended = program(2, Date.now() - 10 * DAY);
        const expired = program(3, Date.now() - 370 * DAY);
        const json = JSON.stringify([{ __integrity__: "test" }, current, ended, expired]);
        writeFileSync(options.legacyPath, json);
        const first = new ProgramHistory(options);
        t.after(() => first.close());
        assert.deepEqual((await first.open()).active, [current]);
        assert.equal((await first.list(range())).items.length, 2);
        observe(first, current, "removed", Date.now(), "overlap", true);
        await first.close();
        assert.equal(readFileSync(options.legacyPath, "utf8"), json);
        writeFileSync(options.legacyPath, "broken after migration");
        const second = new ProgramHistory(options);
        t.after(() => second.close());
        const loaded = await second.open();
        assert.deepEqual(loaded.active, []);
        assert.deepEqual(loaded.removed, [current]);
        assert.equal((await second.list(range())).items.length, 2);
        await second.close();
    });

    it("automatically upgrades schema 1 and durably retains current query order", async t => {
        const options = files(t, "sql-upgrade");
        const original = new ProgramHistory(options);
        await original.open();
        const first = program(1);
        const second = program(2, first.startAt + 3600000);
        observe(original, first);
        observe(original, second);
        observe(original, { ...first, name: "改訂" });
        await original.close();
        const oldDatabase = new DatabaseSync(options.path);
        oldDatabase.exec("DROP TABLE current_programs; PRAGMA user_version=1");
        oldDatabase.close();
        const upgraded = new ProgramHistory(options);
        assert.deepEqual((await upgraded.open()).active, [{ ...first, name: "改訂" }, second]);
        assert.deepEqual(JSON.parse(await upgraded.programs({})), [{ ...first, name: "改訂" }, second]);
        observe(upgraded, first, "removed");
        observe(upgraded, first);
        assert.deepEqual(JSON.parse(await upgraded.programs({})), [second, first]);
        await upgraded.close();
        const restarted = new ProgramHistory(options);
        assert.deepEqual((await restarted.open()).active, [second, first]);
        assert.deepEqual(JSON.parse(await restarted.programs({})), [second, first]);
        await restarted.close();
    });

    it("keeps history when channel integrity changes and prevents old recovery", async t => {
        const options = files(t, "integrity");
        const first = new ProgramHistory(options);
        t.after(() => first.close());
        await first.open();
        observe(first, program(1));
        observe(first, program(2), "removed", Date.now(), "overlap", true);
        await first.close();
        const second = new ProgramHistory({ ...options, integrity: "changed" });
        t.after(() => second.close());
        assert.deepEqual(await second.open(), { active: [], removed: [] });
        const items = (await second.list(range())).items;
        assert.equal(items.length, 2);
        assert.equal(items.find(item => item.program.eventId === 1).status, "archived");
        await second.close();
    });

    it("fails malformed migration without partial imports and retries transactionally", async t => {
        const options = files(t, "malformed");
        writeFileSync(options.legacyPath, JSON.stringify([program(1), { invalid: true }]));
        const bad = new ProgramHistory(options);
        await assert.rejects(bad.open(), /Invalid record/);
        const db = new DatabaseSync(options.path);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM programs").get().n, 0);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM metadata WHERE key='legacy-imported'").get().n, 0);
        db.close();
        writeFileSync(options.legacyPath, JSON.stringify([program(1)]));
        const retry = new ProgramHistory(options);
        t.after(() => retry.close());
        assert.equal((await retry.open()).active.length, 1);
        await retry.close();
    });

    it("expires by the latest end time, cascades versions and retains future schedules", async t => {
        const options = files(t, "retention");
        const history = new ProgramHistory({ ...options, retentionDays: 1 });
        t.after(() => history.close());
        await history.open();
        const now = Date.now();
        const boundary = program(1, now - DAY - 3600000);
        observe(history, boundary);
        observe(history, { ...boundary, name: "second" });
        observe(history, program(2, now + DAY));
        await history.cleanup(now);
        const db = new DatabaseSync(options.path);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM programs").get().n, 2);
        db.close();
        await history.cleanup(now + 1);
        const after = new DatabaseSync(options.path);
        assert.equal(after.prepare("SELECT COUNT(*) AS n FROM programs").get().n, 1);
        assert.equal(after.prepare("SELECT COUNT(*) AS n FROM revisions").get().n, 1);
        after.close();
        await history.close();
    });

    it("makes worker failures explicit and rejects further writes", async t => {
        let failure;
        const history = await memory(t, { onFailure: error => { failure = error; } });
        await history._worker.terminate();
        assert.equal(failure.status, 503);
        assert.throws(() => observe(history, program()), { status: 503 });
        await assert.rejects(history.list(range()), { status: 503 });
    });

    for (const operation of ["write", "cleanup", "open"]) {
        it(`preserves the original ${operation} error after SQLite automatically rolls back`, async t => {
            const options = files(t, `rollback-${operation}`);
            const initial = new ProgramHistory(options);
            await initial.open();
            const original = program();
            observe(initial, original);
            await initial.close();
            const db = new DatabaseSync(options.path);
            const failureMessage = `forced ${operation} storage failure`;
            const target = operation === "write" ? "BEFORE INSERT ON revisions" :
                operation === "cleanup" ? "BEFORE DELETE ON programs" : "BEFORE INSERT ON metadata";
            try {
                db.exec(`CREATE TRIGGER fail_transaction ${target} BEGIN
                    SELECT RAISE(ROLLBACK, '${failureMessage}'); END`);
            } finally { db.close(); }
            const failures = [];
            const history = new ProgramHistory({ ...options, onFailure: error => failures.push(error) });
            const fail = async () => {
                await history.open();
                if (operation === "write") {
                    observe(history, { ...original, name: "must not commit" });
                    await history.flush();
                } else if (operation === "cleanup") {
                    await history.cleanup(Date.now() + 400 * DAY);
                }
            };
            await assert.rejects(fail(), error => {
                assert.equal(error.status, 503);
                assert.ok(error.message.includes(`${operation}: ${failureMessage}`), error.message);
                assert.ok(error.message.includes("ERR_SQLITE_ERROR"), error.message);
                assert.ok(error.message.includes("1811"), error.message);
                assert.ok(error.message.includes("rollback also failed: cannot rollback - no transaction is active"));
                return true;
            });
            assert.equal(failures.length, 1);
            assert.match(failures[0].stack, /ProgramHistoryWorker\.(js|ts)/);
            assert.throws(() => observe(history, program(2)), { status: 503 });
            await assert.rejects(history.programs({}), { status: 503 });
            await history.close();
            const check = new DatabaseSync(options.path);
            try {
                assert.equal(check.prepare("SELECT COUNT(*) AS n FROM revisions").get().n, 1);
                assert.deepEqual(JSON.parse(check.prepare("SELECT internal_json FROM current_programs").get().internal_json), original);
                assert.equal(check.prepare("SELECT COUNT(*) AS n FROM programs").get().n, 1);
                check.exec("DROP TRIGGER fail_transaction");
            } finally { check.close(); }
            const restarted = new ProgramHistory(options);
            assert.deepEqual((await restarted.open()).active, [original]);
            await restarted.close();
        });
    }
});

describe("[program-history.spec] application writers and HTTP cold start", () => {
    it("does not restore expired observations or grow unchanged archive revisions", async t => {
        const options = files(t, "expired-observation");
        const store = install(t, options);
        await store.load();
        const expired = program(1, Date.now() - 5 * DAY);
        for (let i = 0; i < 32; ++i) {
            store.add({ ...expired });
            store.findByNetworkIdAndReplace(1, [{ ...expired }]);
            await store._gc();
        }
        assert.equal(store.get(expired.id), null);
        assert.deepEqual(JSON.parse(await store.history.programs({})), []);
        let item = (await store.history.list(range())).items[0];
        assert.equal(item.status, "archived");
        assert.equal(item.revision, 1);
        for (let i = 0; i < 32; ++i) { observe(store.history, expired); }
        item = (await store.history.list(range())).items[0];
        assert.equal(item.revision, 1, "worker also fences stale active observations");
        const corrected = { ...expired, startAt: Date.now() - 60000 };
        store.add(corrected);
        assert.deepEqual(JSON.parse(await store.history.programs({})), [corrected]);
    });

    it("commits complete EIT audio descriptors once per event observation", async t => {
        const options = files(t, "eit-audio");
        const store = install(t, options);
        await store.load();
        const EPG = require("../lib/Mirakurun/EPG").default;
        const timestamp = Math.floor((Date.now() + DAY) / 1000) * 1000;
        const local = new Date(timestamp + 9 * 3600000);
        const mjd = Math.floor(local.getTime() / DAY) + 40587;
        const bcd = n => (Math.floor(n / 10) << 4) | n % 10;
        const eit = {
            table_id: 0x50, section_number: 0, version_number: 0,
            original_network_id: 1, service_id: 1,
            events: [{ event_id: 1,
                start_time: Buffer.from([mjd >> 8, mjd & 255, bcd(local.getUTCHours()), bcd(local.getUTCMinutes()), bcd(local.getUTCSeconds())]),
                duration: Buffer.from([1, 0, 0]), free_CA_mode: 0,
                descriptors: [16, 17, 18].map(tag => ({ descriptor_tag: 0xC4, component_tag: tag,
                    component_type: 3, main_component_flag: tag === 16 ? 1 : 0,
                    sampling_rate: 7, ISO_639_language_code: Buffer.from("jpn") })) }]
        };
        // Independent gatherers reset parser state but must not manufacture
        // partial audio revisions on every pass.
        for (let i = 0; i < 32; ++i) { new EPG().write(eit); }
        const item = (await store.history.list(range())).items[0];
        assert.equal(item.revision, 1);
        assert.equal(item.program.audios.length, 3);
        assert.equal((await store.history.revisions(item.historyId, {})).items.length, 1);
        eit.version_number = 1;
        eit.events[0].descriptors[1].component_type = 9;
        new EPG().write(eit);
        const updated = (await store.history.list(range())).items[0];
        assert.equal(updated.revision, 2);
        assert.equal(updated.program.audios[1].componentType, 9);
    });

    it("tracks EIT timing corrections and resets descriptor state when event IDs are reused", async t => {
        const options = files(t, "eit");
        const store = install(t, options);
        await store.load();
        const EPG = require("../lib/Mirakurun/EPG").default;
        const epg = new EPG();
        const bcd = value => ((Math.floor(value / 10) << 4) | (value % 10));
        const startTime = timestamp => {
            const local = new Date(timestamp + 9 * 3600000);
            const mjd = Math.floor(local.getTime() / DAY) + 40587;
            return Buffer.from([mjd >> 8, mjd & 255, bcd(local.getUTCHours()), bcd(local.getUTCMinutes()), bcd(local.getUTCSeconds())]);
        };
        const event = (time, version) => ({
            table_id: 0x50, section_number: 0, version_number: version,
            original_network_id: 1, service_id: 1,
            events: [{ event_id: 1, start_time: startTime(time), duration: Buffer.from([1, 0, 0]), free_CA_mode: 0, descriptors: [] }]
        });
        const future = Math.floor((Date.now() + DAY) / 1000) * 1000;
        epg.write(event(future, 0));
        store.set(getProgramItemId(1, 1, 1), { name: "old metadata" });
        epg.write(event(future + 3600000, 1));
        let items = (await store.history.list(range())).items;
        assert.equal(items.length, 1);
        assert.equal(items[0].program.startAt, future + 3600000);
        // Make the previous occurrence ended; the same parser table version
        // on the new occurrence must not suppress the new event timing.
        const past = Math.floor((Date.now() - DAY) / 1000) * 1000;
        epg.write(event(past, 2));
        epg.write(event(future, 2));
        items = (await store.history.list(range())).items;
        assert.equal(items.length, 2);
        assert.equal(store.get(getProgramItemId(1, 1, 1)).startAt, future);
        assert.equal(store.get(getProgramItemId(1, 1, 1)).name, undefined);
        assert.equal(items.find(item => item.status === "archived").program.name, "old metadata");
    });
    it("captures local field changes, remote replacement, conflicts and recovery through Program", async t => {
        const options = files(t, "writers");
        const store = install(t, options);
        await store.load();
        const first = program(1);
        store.add(first);
        store.set(first.id, { name: "renamed" });
        store.set(first.id, { description: "changed" });
        const overlapping = program(2, first.startAt + 1000);
        store.add(overlapping);
        assert.equal(store.get(first.id), null);
        store.set(first.id, { startAt: first.startAt + 2 * DAY });
        assert.ok(store.get(first.id));
        const history = (await store.history.list(range())).items;
        const firstHistory = history.find(item => item.program.eventId === 1);
        const revisions = (await store.history.revisions(firstHistory.historyId, {})).items;
        assert.deepEqual(revisions.map(item => item.changeType), ["create", "update", "update", "remove", "restore", "update"]);
        store.findByNetworkIdAndReplace(1, [{ ...first, name: "remote" }]);
        const changed = (await store.history.list(range())).items;
        assert.equal(changed.find(item => item.program.eventId === 2).status, "removed");
        assert.equal(changed.find(item => item.program.eventId === 1).program.name, "remote");
    });

    it("automatically migrates the untouched legacy file and serves full current/history HTTP contracts", async t => {
        const options = files(t, "http");
        const current = program(1);
        const ended = program(2, Date.now() - 10 * DAY);
        const contents = JSON.stringify([{ __integrity__: "test" }, current, ended]);
        writeFileSync(options.legacyPath, contents);
        const store = install(t, options);
        // Status sampler owns process-wide timers; unref only its import timers.
        const setTimeoutOriginal = global.setTimeout;
        let Server;
        global.setTimeout = (...args) => setTimeoutOriginal(...args).unref();
        try { ({ Server } = require("../lib/Mirakurun/Server")); } finally { global.setTimeout = setTimeoutOriginal; }
        const server = new Server();
        server.testMode = true;
        _.server = server;
        _.tuner = { devices: [] };
        _.service = { items: [], get: () => ({ id: 100001 }) };
        _.channel = { items: [] };
        _.config.server = { ..._.config.server, port: 0, disableIPv6: true, disableWebUI: true,
            allowIPv4CidrRanges: ["127.0.0.0/8"], allowIPv6CidrRanges: [], allowOrigins: [] };
        t.after(async () => {
            for (const listener of server.servers) { listener.closeAllConnections(); }
            const restoredProgram = _.program;
            _.program = store;
            try { await server.deinit(); } finally { _.program = restoredProgram; }
        });
        await store.load();
        await server.init();
        const base = `http://127.0.0.1:${[...server.servers][0].address().port}/api`;
        const request = async (url, status = 200) => {
            const response = await fetch(base + url);
            assert.equal(response.status, status, url);
            return response.json();
        };
        assert.deepEqual(await request("/programs"), [current]);
        assert.deepEqual(await request(`/programs/${current.id}`), current);
        await request(`/programs/${ended.id}`, 404);
        const query = new URLSearchParams(range()).toString();
        const page = await request(`/program-history?${query}`);
        assert.equal(page.items.length, 2);
        const archived = page.items.find(item => item.program.eventId === 2);
        assert.deepEqual(archived.program, ended);
        assert.equal(archived.status, "archived");
        assert.deepEqual(await request(`/program-history/${archived.historyId}`), archived);
        const revisions = await request(`/program-history/${archived.historyId}/revisions`);
        assert.deepEqual(revisions.items[0].program, ended);
        assert.equal(revisions.items[0].reason, "legacy-import");
        assert.equal(revisions.nextCursor, null);
        const xml = await fetch(base + "/iptv/xmltv");
        assert.equal(xml.status, 200);
        const text = await xml.text();
        assert.equal((text.match(/<programme /g) || []).length, 1);
        assert.ok(text.includes("<title>番組</title>"));
        for (const url of ["/program-history", `/program-history?${query}&unexpected=1`,
            `/program-history?${query}&limit=501`, `/program-history?${query}&cursor=invalid`,
            "/program-history/not-a-uuid"]) { await request(url, 400); }
        await request(`/program-history/${randomUUID()}`, 404);
        await request(`/program-history/${randomUUID()}/revisions`, 404);
        store.set(current.id, { name: "updated" });
        assert.deepEqual(await request("/programs"), [store.get(current.id)]);
        const updated = await request(`/program-history?${query}&eventId=1`);
        assert.equal(updated.items[0].program.name, "updated");
        assert.deepEqual(await request("/programs"), [store.get(current.id)]);
        const versionPage = await request(`/program-history/${updated.items[0].historyId}/revisions?limit=1`);
        assert.ok(versionPage.nextCursor);
        const second = await request(`/program-history/${updated.items[0].historyId}/revisions?cursor=${versionPage.nextCursor}`);
        assert.equal(second.items[0].program.name, "updated");
        assert.equal(readFileSync(options.legacyPath, "utf8"), contents);
        for (let eventId = 10; eventId < 130; ++eventId) {
            store.add({ ...program(eventId, current.startAt + eventId * 3600000), description: "内容".repeat(eventId < 12 ? 100000 : 2000) });
        }
        const all = await request(`/program-history?${query}&limit=500`);
        const concurrent = await Promise.all(Array.from({ length: 3 }, () => request(`/program-history?${query}&limit=500`)));
        for (const response of concurrent) { assert.equal(JSON.stringify(response) === JSON.stringify(all), true, "complete concurrent history page"); }
        const expectedCurrent = [...store.itemMap.values()];
        const responses = await Promise.all(["/programs", "/programs?networkId=1", "/programs?name=番組"].map(url => request(url)));
        assert.deepEqual(responses[0], expectedCurrent);
        assert.deepEqual(responses[1], expectedCurrent);
        assert.deepEqual(responses[2], expectedCurrent.filter(item => item.name === "番組"));
        const unicodeResponse = await fetch(base + "/programs");
        const bytes = Buffer.from(await unicodeResponse.arrayBuffer());
        assert.equal(Number(unicodeResponse.headers.get("content-length")), bytes.length);
        await request("/programs?name%5B%24where%5D=true", 400);
        await store.history.close();
        await request("/programs", 503);
        await request(`/program-history?${query}`, 503);
        await request(`/program-history/${archived.historyId}`, 503);
        await request(`/program-history/${archived.historyId}/revisions`, 503);
    });
});

// Opt-in acceptance against an exact copy of the supplied production snapshot.
// The caller owns the copy, size budget and cleanup; never open the source writable.
it("[program-history snapshot] cold start fences repeated expired observations through HTTP", {
    skip: !process.env.MIRAKURUN_EPG_SNAPSHOT_COPY
}, async t => {
    const path = process.env.MIRAKURUN_EPG_SNAPSHOT_COPY;
    const db = new DatabaseSync(path, { readOnly: true });
    let integrity, rows, archived, counts;
    try {
        integrity = db.prepare("SELECT value FROM metadata WHERE key='channels-integrity'").get().value;
        rows = db.prepare("SELECT internal_json FROM current_programs ORDER BY position").all().map(r => JSON.parse(r.internal_json));
        archived = db.prepare("SELECT * FROM programs WHERE end_at < ? ORDER BY revision DESC LIMIT 1").get(Date.now() - 3 * 3600000);
        counts = db.prepare("SELECT COUNT(*) AS n FROM revisions").get().n;
    } finally { db.close(); }
    assert.ok(rows.length > 0);
    assert.ok(archived);
    console.log(JSON.stringify({ snapshotBefore: { current: rows.length, revisions: counts, historyId: archived.history_id } }));
    const options = { path, legacyPath: path + ".absent", integrity, retentionDays: 365 };
    const store = install(t, options);
    _.configIntegrity.channels = integrity;
    const originalTimeout = global.setTimeout;
    let Server;
    global.setTimeout = (...args) => originalTimeout(...args).unref();
    try { ({ Server } = require("../lib/Mirakurun/Server")); } finally { global.setTimeout = originalTimeout; }
    const server = new Server();
    server.testMode = true;
    _.server = server;
    _.tuner = { devices: [] };
    _.service = { items: [], get: () => ({ id: 100001 }) };
    _.channel = { items: [] };
    _.config.server = { ..._.config.server, port: 0, disableIPv6: true, disableWebUI: true,
        allowIPv4CidrRanges: ["127.0.0.0/8"], allowIPv6CidrRanges: [], allowOrigins: [] };
    t.after(async () => {
        for (const listener of server.servers) { listener.closeAllConnections(); }
        const restoredProgram = _.program;
        _.program = store;
        try { await server.deinit(); } finally { _.program = restoredProgram; }
    });
    const beforeOpen = Date.now();
    await store.load();
    await server.init();
    const base = `http://127.0.0.1:${[...server.servers][0].address().port}/api`;
    const request = async url => {
        const response = await fetch(base + url);
        assert.equal(response.status, 200, url);
        return response.json();
    };
    const expected = rows.filter(p => p.startAt + p.duration >= beforeOpen && p.startAt <= beforeOpen + 9 * DAY);
    assert.deepEqual(await request("/programs"), expected);
    const first = expected[0];
    assert.ok(first);
    const publicFirst = Object.fromEntries(Object.entries(first).filter(([k]) => !k.startsWith("_")));
    assert.deepEqual(await request(`/programs/${first.id}`), publicFirst);
    const item = await request(`/program-history/${archived.history_id}`);
    assert.equal(item.status, "archived");
    assert.deepEqual(item.program, JSON.parse(archived.program_json));
    const versions = await request(`/program-history/${archived.history_id}/revisions`);
    assert.ok(versions.items.length > 0);
    const baselineRevision = item.revision;
    const old = JSON.parse(archived.internal_json);
    for (let i = 0; i < 32; ++i) { store.findByNetworkIdAndReplace(old.networkId,
        [...store.itemMap.values()].filter(p => p.networkId === old.networkId).concat(old)); }
    const after = await request(`/program-history/${archived.history_id}`);
    assert.deepEqual(after, item);
    assert.equal(after.revision, baselineRevision);
    assert.deepEqual(await request("/programs"), expected);
    const query = new URLSearchParams({ from: old.startAt - DAY, to: old.startAt + DAY,
        networkId: old.networkId, serviceId: old.serviceId, eventId: old.eventId }).toString();
    assert.ok((await request(`/program-history?${query}`)).items.some(p => p.historyId === archived.history_id));
    console.log(JSON.stringify({ snapshotAfter: { current: expected.length, repeatedObservations: 32,
        archivedRevisionBefore: baselineRevision, archivedRevisionAfter: after.revision } }));
});
