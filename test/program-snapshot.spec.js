/*
   Copyright 2026 Mirakurun contributors

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
const { setImmediate: yieldImmediate } = require("node:timers/promises");
const { ProgramSnapshot, serializePrograms } = require("../lib/Mirakurun/ProgramSnapshot");
const { Program } = require("../lib/Mirakurun/Program");
const Event = require("../lib/Mirakurun/Event").default;
const _ = require("../lib/Mirakurun/_").default;
const log = require("../lib/Mirakurun/log");
const yieldable = require("yieldable-json");

function store(items) {
    const program = Object.create(Program.prototype);
    program._itemMap = new Map(items.map(item => [item.id, item]));
    program._itemMapDeleted = new Map();
    program._emitPrograms = new Map();
    program.save = () => {};
    return program;
}

function items(count = 150) {
    return Array.from({ length: count }, (_, i) => ({
        id: 10000000001 + i,
        networkId: 1,
        serviceId: i % 2 + 1,
        eventId: i,
        startAt: 1700000000000,
        duration: 60000,
        isFree: true,
        name: "番組 \"test\"\\\n" + i,
        description: "番組詳細".repeat(150),
        extended: { text: "old" },
        genres: [{ lv1: 1, lv2: 2 }],
        _isPresent: i === 0 ? true : undefined
    }));
}

async function parsed(snapshot, query = {}) {
    return JSON.parse(await snapshot.getResponse(query));
}

describe("[program-snapshot.spec] complete independent snapshots", () => {
    it("captures before yielding and includes writers only in the next generation", async () => {
        const program = store(items());
        const expected = [...program.itemMap.values()].map(item => JSON.parse(JSON.stringify(item)));
        const pending = program.snapshot.refresh();
        assert.strictEqual(program.snapshot.refresh(), pending);
        await yieldImmediate();
        program.set(expected[0].id, { name: "new", extended: { text: "new" }, genres: [{ lv1: 9, lv2: 9 }] });
        program.set(expected.at(-1).id, { name: "new" });
        program.remove(expected[1].id);
        program.add({ ...expected[0], id: 20000000001 }, true);
        await pending;
        assert.deepStrictEqual(await parsed(program.snapshot), expected);
        const previous = await program.snapshot.getResponse({});
        const refresh = program.snapshot.refresh();
        assert.strictEqual(await program.snapshot.getResponse({}), previous);
        await refresh;
        assert.deepStrictEqual(await parsed(program.snapshot), JSON.parse(JSON.stringify([...program.itemMap.values()])));
    });

    it("keeps filtered requests on the same generation and rejects unsafe queries", async () => {
        const program = store(items());
        await program.snapshot.refresh();
        const snapshotItems = await parsed(program.snapshot);
        program.set(snapshotItems[0].id, { networkId: 99 });
        assert.deepStrictEqual(await parsed(program.snapshot, { networkId: 1, serviceId: 1 }),
            snapshotItems.filter(item => item.networkId === 1 && item.serviceId === 1));
        assert.deepStrictEqual(await parsed(program.snapshot, { eventId: { $gte: 148 } }), snapshotItems.slice(148));
        await assert.rejects(program.snapshot.getResponse({ name: { $where: "true" } }), /\$where/);
    });

    it("does not share serializer state with other requests or database serialization", async () => {
        const program = store(items());
        program.itemMap.values().next().value.description = "A".repeat(150000);
        await program.snapshot.refresh();
        const expected = await program.snapshot.getResponse({});
        const expectedFiltered = JSON.stringify((await parsed(program.snapshot)).filter(item => item.serviceId === 1));
        const dbSerialization = new Promise((resolve, reject) => {
            yieldable.stringifyAsync([{ __integrity__: "test" }, ...program.itemMap.values()], (err, json) => {
                if (err) { reject(err); } else { resolve(json); }
            });
        });
        const refresh = program.snapshot.refresh();
        const responses = await Promise.all(Array.from({ length: 3 }, () => program.snapshot.getResponse({})));
        const filtered = await Promise.all(Array.from({ length: 3 }, () => program.snapshot.getResponse({ serviceId: 1 })));
        const dbJSON = await dbSerialization;
        await refresh;
        for (const response of responses) { assert.strictEqual(response, expected); }
        for (const response of filtered) { assert.strictEqual(response.toString(), expectedFiltered); }
        assert.deepStrictEqual(JSON.parse(dbJSON).slice(1), await parsed(program.snapshot));
    });

    it("serializes empty stores, Unicode, long strings, nested arrays and shared objects correctly", async () => {
        assert.strictEqual((await serializePrograms([])).toString(), "[]");
        const shared = { text: "\u2028\ud800\u0000😀" };
        const data = [{ name: "A".repeat(150000), extended: shared, nested: [shared, { values: [null, undefined, NaN] }] }];
        const responses = await Promise.all([serializePrograms(data), serializePrograms(data)]);
        for (const response of responses) { assert.strictEqual(response.toString(), JSON.stringify(data)); }
    });

    it("refreshes on changes without starvation, skips idle work, retains failures and retries", async t => {
        t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
        const errors = [];
        t.mock.method(log, "error", (...args) => errors.push(args));
        const data = [{ id: 1, name: "old" }];
        let captures = 0;
        const snapshot = new ProgramSnapshot(() => { captures++; return data; });
        t.after(() => snapshot.stop());
        await snapshot.start();
        const old = await snapshot.getResponse({});
        data[0].name = "new";
        snapshot.invalidate();
        t.mock.timers.tick(500);
        snapshot.invalidate();
        t.mock.timers.tick(499);
        assert.strictEqual(await snapshot.getResponse({}), old);
        assert.strictEqual(captures, 1);
        t.mock.timers.tick(1);
        await snapshot.refresh();
        assert.deepStrictEqual(await parsed(snapshot), data);
        const good = await snapshot.getResponse({});
        const idleCaptures = captures;
        t.mock.timers.tick(30000);
        assert.strictEqual(captures, idleCaptures);
        data[0].unsupported = 1n;
        snapshot.invalidate();
        t.mock.timers.tick(1000);
        await assert.rejects(snapshot.refresh(), /BigInt/);
        await yieldImmediate();
        assert.strictEqual(await snapshot.getResponse({}), good);
        assert.strictEqual(errors.length, 1);
        assert.match(errors[0][0], /snapshotAgeMs/);
        delete data[0].unsupported;
        data[0].name = "retry succeeded";
        t.mock.timers.tick(30000);
        await snapshot.refresh();
        assert.deepStrictEqual(await parsed(snapshot), data);
        await snapshot.stop();
        const stoppedCaptures = captures;
        t.mock.timers.tick(60000);
        assert.strictEqual(captures, stoppedCaptures);
        await assert.rejects(snapshot.getResponse({}), /not ready/);
    });

    it("reports missing or failed initial snapshots instead of returning an empty EPG", async () => {
        const snapshot = new ProgramSnapshot(() => [{ id: 1, unsupported: 1n }]);
        await assert.rejects(snapshot.getResponse({}), /not ready/);
        await assert.rejects(snapshot.start(), /BigInt/);
        await assert.rejects(snapshot.getResponse({}), /not ready/);
        const empty = new ProgramSnapshot(() => []);
        await empty.refresh();
        assert.deepStrictEqual(await parsed(empty), []);
    });

    it("does not restart a refresh timer after shutdown during initial preparation", async t => {
        const snapshot = new ProgramSnapshot(() => items());
        const interval = t.mock.method(global, "setTimeout");
        const start = snapshot.start();
        const stop = snapshot.stop();
        await Promise.all([start, stop]);
        assert.strictEqual(interval.mock.callCount(), 0);
        await assert.rejects(snapshot.getResponse({}), /not ready/);
    });
});

describe("[program-snapshot.spec] application HTTP entry point", () => {
    it("prepares before listening and serves complete cached and filtered responses", async t => {
        // The existing status sampler owns process-wide timers, unrelated to
        // this server fixture. Unref its initial timers so the test can exit.
        const realSetTimeout = global.setTimeout;
        global.setTimeout = (...args) => realSetTimeout(...args).unref();
        let Server;
        try {
            ({ Server } = require("../lib/Mirakurun/Server"));
        } finally {
            global.setTimeout = realSetTimeout;
        }
        const previous = { program: _.program, server: _.server, tuner: _.tuner, event: _.event, config: _.config.server };
        const program = store(items());
        const server = new Server();
        server.testMode = true;
        _.program = program;
        _.server = server;
        _.tuner = { devices: [] };
        _.event = new Event();
        _.config.server = {
            port: 0, disableIPv6: true, disableWebUI: true,
            allowIPv4CidrRanges: ["127.0.0.0/8"], allowIPv6CidrRanges: [], allowOrigins: []
        };
        t.after(async () => {
            for (const listener of server.servers) { listener.closeAllConnections(); }
            await server.deinit();
            _.program = previous.program;
            _.server = previous.server;
            _.tuner = previous.tuner;
            _.event = previous.event;
            _.config.server = previous.config;
        });
        await server.init();
        const listener = [...server.servers][0];
        const base = `http://127.0.0.1:${listener.address().port}`;
        const expected = await parsed(program.snapshot);
        program.set(expected[0].id, { name: "not published yet" });
        const response = await fetch(base + "/api/programs");
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get("content-type"), "application/json; charset=utf-8");
        const bytes = Buffer.from(await response.arrayBuffer());
        assert.strictEqual(Number(response.headers.get("content-length")), bytes.length);
        assert.deepStrictEqual(JSON.parse(bytes), expected);
        const filtered = await fetch(base + "/api/programs?networkId=1&serviceId=1");
        assert.strictEqual(filtered.status, 200);
        assert.deepStrictEqual(await filtered.json(), expected.filter(item => item.serviceId === 1));
        const blocked = await fetch(base + "/api/programs?name[$where]=true");
        assert.strictEqual(blocked.status, 400);
        assert.deepStrictEqual(await blocked.json(), { code: 400, reason: null, errors: [] });
        const refresh = program.snapshot.refresh();
        const responses = await Promise.all(Array.from({ length: 3 }, () => fetch(base + "/api/programs")));
        for (const concurrent of responses) {
            assert.strictEqual(concurrent.status, 200);
            const data = await concurrent.json();
            assert.ok(JSON.stringify(data) === JSON.stringify(expected) ||
                JSON.stringify(data) === JSON.stringify([...program.itemMap.values()]));
        }
        await refresh;
        const updated = await fetch(base + "/api/programs");
        assert.deepStrictEqual(await updated.json(), JSON.parse(JSON.stringify([...program.itemMap.values()])));
        await program.snapshot.stop();
        const unavailable = await fetch(base + "/api/programs");
        assert.strictEqual(unavailable.status, 500);
        assert.strictEqual((await unavailable.json()).reason, "Program snapshot is not ready");
    });
});
