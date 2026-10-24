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
    const store = new GGuideStore({ gguideOpen: async () => state, gguideSave: async () => state }, 1024);
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
