const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ProgramHistory } = require("../lib/Mirakurun/ProgramHistory");
const { default: GGuideStore, digest, GGUIDE_RETENTION_MS } = require("../lib/Mirakurun/GGuideStore");

test("indexed capture writes preserve earlier rows, merge repeated IDs and keep counts independent of resolution", async t => {
    const history = new ProgramHistory({ path: ":memory:", integrity: "test", retentionDays: 365 });
    t.after(() => history.close());
    await history.open();
    const now = Date.now();
    const source = { channelType: "GR", channel: "16", serviceId: 2199, pid: 100,
        moduleHash: "a".repeat(64), recordOffset: 1, imageOffset: 2, firstReceivedAt: now, lastReceivedAt: now };
    const material = value => {
        const data = Buffer.from(value);
        return { data, asset: { id: digest(data), mimeType: "image/jpeg", width: 1, height: 1, size: data.length,
            displayable: true, firstReceivedAt: now, lastReceivedAt: now, sources: [{ ...source }] } };
    };
    const first = material("one"), second = material("two");
    const binding = { id: "b".repeat(64), kind: "nap", objectId: 1, channelType: "GR", channel: "16", serviceId: 2199,
        firstReceivedAt: now, lastReceivedAt: now, members: [{ role: "detailImage", assetId: first.asset.id }] };
    const store = new GGuideStore(history, 1024 * 1024);
    await store.init();
    await store.save([first, second], new Map(), undefined, [binding]);
    const changed = structuredClone(first);
    changed.asset.lastReceivedAt = now + 1000;
    changed.asset.sources = [{ ...source, lastReceivedAt: now + 1000 },
        { ...source, moduleHash: "c".repeat(64) }, { ...source, moduleHash: "c".repeat(64), lastReceivedAt: now + 1000 }];
    await store.save([changed], new Map(), undefined, [
        { ...binding, members: [{ role: "detailText", text: "received text" }] },
        { ...binding, members: [{ role: "banner", assetId: second.asset.id }] }
    ]);
    const state = await history.gguideOpen(store.maxBytes);
    assert.equal(state.assets.length, 2);
    const merged = state.assets.find(asset => asset.id === first.asset.id);
    assert.equal(merged.sources.length, 2);
    assert.ok(merged.sources.every(item => item.lastReceivedAt === now + 1000));
    assert.deepEqual(state.assets.find(asset => asset.id === second.asset.id), second.asset);
    assert.equal(state.bindings[0].members.length, 3);
    assert.equal(state.bindings[0].members.find(member => member.role === "detailText").text, "received text");
    store.list = () => { throw new Error("status must not resolve the program graph"); };
    assert.equal(store.assetCount, 2);
    assert.equal(store.bindingCount, 1);
    assert.deepEqual(Buffer.from((await store.read(first.asset.id)).data), first.data);
    await store.prune(now + GGUIDE_RETENTION_MS + 2000);
    assert.equal(store.assetCount, 0);
    assert.equal(store.bindingCount, 0);
    assert.equal(await store.read(first.asset.id), undefined);
});

test("reuses resolved associations until a write or the earliest fact, binding or image expiry", async t => {
    const index = require("../lib/Mirakurun/GGuideProgramIndex");
    const resolve = index.resolveGGuidePrograms, clock = Date.now;
    let calls = 0, now = clock();
    index.resolveGGuidePrograms = (...args) => { calls++; return resolve(...args); };
    Date.now = () => now;
    t.after(() => { index.resolveGGuidePrograms = resolve; Date.now = clock; });
    const state = { assets: [{ id: "image", lastReceivedAt: now - GGUIDE_RETENTION_MS + 1000, sources: [] }],
        modules: [], moduleReceivedAt: {},
        bindings: [{ id: "binding", kind: "nap", objectId: 1, lastReceivedAt: now - GGUIDE_RETENTION_MS + 500,
            members: [{ role: "detailImage", assetId: "image" }, { role: "detailText", text: "detail" }] }],
        programIndex: [{ scope: "GR/16/2199", value: { kind: "switch", id: "unused" }, receivedAt: now - GGUIDE_RETENTION_MS + 100 }] };
    const store = new GGuideStore({ gguideOpen: async () => structuredClone(state), gguideSave: async () => ({ cutoff: now - GGUIDE_RETENTION_MS, assets: [], bindings: [], modules: [], moduleReceivedAt: {} }) }, 1024);
    await store.init();
    const first = store.list();
    assert.equal(first[0].advertisements[0].text, "detail");
    first[0].advertisements[0].text = "caller mutation";
    assert.equal(store.list()[0].advertisements[0].text, "detail");
    assert.equal(calls, 1);
    now += 100;
    store.list(); assert.equal(calls, 2, "expired index fact invalidates the graph");
    await store.save([], new Map(), undefined);
    store.list(); assert.equal(calls, 3, "successful publication invalidates the graph");
    now += 400;
    assert.deepEqual(store.list()[0].advertisements, []);
    assert.equal(calls, 4, "expired binding is removed without waiting for cleanup");
    now += 500;
    assert.deepEqual(store.list(), []);
    assert.equal(calls, 5);
});


test("capture publication acknowledges only committed deltas, including arrivals during a pending write", () => {
    const { createGGuidePublication } = require("../lib/Mirakurun/GGuideCapture");
    const capture = { materials: new Map(), modules: new Map(), bindings: [], programIndex: new Map(), receptionPlans: new Map() };
    const snapshot = createGGuidePublication(capture);
    const fact = { scope: "scope", value: { kind: "switch", id: "node" }, receivedAt: 1 };
    const asset = { id: "image", sources: [{ lastReceivedAt: 1 }], lastReceivedAt: 1 };
    capture.materials.set("image", { data: Buffer.from("image"), asset });
    capture.modules.set("module", Buffer.from("module"));
    capture.bindings.push({ id: "binding-one" });
    capture.programIndex.set("fact", fact);
    const plan = { id: "plan", receivedAt: 1, windows: [] };
    capture.receptionPlans.set("plan", plan);
    const first = snapshot();
    assert.equal(first.materials.length, 1);
    assert.equal(snapshot().materials.length, 1, "failed/uncommitted write must remain pending");
    asset.sources.push({ lastReceivedAt: 1 }); // Same millisecond, still a changed source.
    capture.bindings.push({ id: "binding-two" });
    const newer = { ...fact, receivedAt: 2 };
    capture.programIndex.set("fact", newer);
    const newerPlan = { ...plan, receivedAt: 2 };
    capture.receptionPlans.set("plan", newerPlan);
    assert.equal(first.materials[0].asset.sources.length, 1, "in-flight metadata is isolated");
    first.commit();
    const second = snapshot();
    assert.equal(second.materials[0].asset.sources.length, 2);
    assert.deepEqual(second.bindings, [{ id: "binding-two" }]);
    assert.deepEqual(second.programIndex, [newer]);
    assert.deepEqual(second.receptionPlans, [newerPlan]);
    assert.equal(second.modules.size, 0);
    second.commit();
    const empty = snapshot();
    assert.equal(empty.materials.length + empty.bindings.length + empty.programIndex.length + empty.modules.size + empty.receptionPlans.length, 0);
});

test("worker returns only committed changes and preserves prior index facts through image-only writes and reopen", async t => {
    const history = new ProgramHistory({ path: ":memory:", integrity: "test", retentionDays: 365 });
    t.after(() => history.close());
    await history.open();
    const store = new GGuideStore(history, 1024 * 1024);
    await store.init();
    const now = Date.now();
    const facts = [{ scope: "scope", value: { kind: "switch", id: "node" }, receivedAt: now }];
    await store.save([], new Map(), undefined, [], facts);
    const data = Buffer.from("one");
    const material = { data, asset: { id: digest(data), mimeType: "image/jpeg", width: 1, height: 1,
        size: data.length, displayable: true, sources: [], firstReceivedAt: now, lastReceivedAt: now } };
    await store.save([material], new Map(), undefined);
    const update = await history.gguideSave({ materials: [], modules: [], bindings: [], maxBytes: store.maxBytes });
    assert.deepEqual(update.assets, []);
    assert.deepEqual(update.programIndex, [], "unchanged index must not cross the worker boundary");
    const reopened = await history.gguideOpen(store.maxBytes);
    assert.deepEqual(reopened.programIndex, facts);
    assert.equal(reopened.assets.length, 1);
    await assert.rejects(store.save([{ ...material, data: Buffer.from("bad") }], new Map(), undefined), /hash mismatch/);
    assert.equal(store.list().length, 1, "failed transaction must not replace the visible state");
});


test("capture completion flushes arrivals after an in-flight publication without replaying committed materials", async t => {
    const GGuide = require("../lib/Mirakurun/GGuide").default;
    const nativeInterval = global.setInterval;
    let tick, release;
    global.setInterval = fn => { tick = fn; return nativeInterval(() => {}, 100000); };
    t.after(() => { global.setInterval = nativeInterval; });
    const capture = { materials: new Map(), modules: new Map(), bindings: [], programIndex: new Map(), receptionPlans: new Map(), seen: new Set(["one"]) };
    const material = id => ({ data: Buffer.from(id), asset: { id, sources: [], lastReceivedAt: 1 } });
    capture.materials.set("one", material("one"));
    const writes = [];
    const stop = GGuide.prototype.publishDuringCapture.call({ pendingSaves: new Set(), store: { save: async (...args) => {
        writes.push(args);
        if (writes.length === 1) { await new Promise(resolve => { release = resolve; }); }
    } } }, capture, error => { throw error; });
    t.after(() => stop());
    tick();
    capture.materials.set("two", material("two"));
    capture.seen.add("two");
    release();
    const result = { status: "completed" };
    await stop(result);
    assert.deepEqual(writes.map(args => args[0].map(item => item.asset.id)), [["one"], ["two"]]);
    assert.equal(writes[1][2], result);
});
