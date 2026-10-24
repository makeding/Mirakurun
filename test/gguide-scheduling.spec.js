const assert = require("node:assert/strict");
const { test } = require("node:test");
const { setImmediate: nextTurn, setTimeout: sleep } = require("node:timers/promises");

const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = {
    id: statusPath, filename: statusPath, loaded: true,
    exports: { __esModule: true, default: { streamCount: { tsFilter: 0 }, epg: {} } }
};
const _ = require("../lib/Mirakurun/_").default;
const GGuide = require("../lib/Mirakurun/GGuide").default;
const ChannelItem = require("../lib/Mirakurun/ChannelItem").default;

function channel(type, name, networkId, streamId, route = "TER") {
    const item = new ChannelItem({ type, channel: name, name, route });
    if (networkId) { item.setStream(0, streamId, networkId, false); }
    return item;
}

function guide(channels) {
    _.config.server = { gguideSchedule: "", gguideDurationSeconds: 1, disableEITParsing: true };
    _.config.tuners = [{ types: ["GR"] }, { types: ["GR-ALT"] }, { types: ["GR-ALT"] }];
    _.channel = { items: channels, get: (type, name) => channels.find(item => item.type === type && item.channel === name) };
    _.job = { jobs: [] };
    _.program = { history: {} };
    return new GGuide();
}

test("satellite fanout never enumerates terrestrial GGuide targets", t => {
    const previous = { channel: _.channel, job: _.job, program: _.program, server: _.config.server, tuners: _.config.tuners };
    t.after(() => {
        _.channel = previous.channel; _.job = previous.job; _.program = previous.program;
        _.config.server = previous.server; _.config.tuners = previous.tuners;
    });
    const value = guide([]);
    value.initialized = true;
    let discoveries = 0;
    value.getTargets = () => { discoveries++; return []; };
    const ended = [];
    value.endObservation = id => ended.push(id);
    for (const type of ["BS", "CS", "BS4K"]) {
        for (let i = 0; i < 100; i++) value.observe(2, { type, channel: "test" }, Buffer.alloc(188));
    }
    assert.equal(discoveries, 0);
    assert.equal(ended.length, 300, "finish any terrestrial observation left on the retuned device");
    for (const type of ["GR", "GR-ALT"]) value.observe(0, { type, channel: "13" }, Buffer.alloc(188));
    assert.equal(discoveries, 2, "terrestrial discovery remains available");
});

test("passive observe caches an unconfigured source until explicit target refresh", t => {
    const previous = { channel: _.channel, service: _.service };
    t.after(() => { _.channel = previous.channel; _.service = previous.service; });
    const value = guide([channel("GR", "13", 32080, 200)]);
    value.initialized = true;
    let discoveries = 0;
    _.service = { findByChannel: () => { discoveries++; return []; } };
    value.observe(0, { type: "GR", channel: "13" }, Buffer.alloc(0));
    value.observe(0, { type: "GR", channel: "13" }, Buffer.alloc(0));
    assert.equal(discoveries, 1);
    _.service = { findByChannel: () => [{ serviceId: 2199, name: "Ｇガイド" }] };
    assert.deepEqual(value.getTargets(), [{ channelType: "GR", channel: "13", serviceId: 2199, durationSeconds: 1 }]);
});

test("targets deduplicate 22/T22 and known alternate routes while preserving regions and distinct known broadcasts", () => {
    const value = guide([
        channel("GR-ALT", "22"),
        channel("GR-ALT", "T22", 32739, 100),
        channel("GR-ALT", "022", 32740, 101),
        channel("GR", "22", 32080, 200),
        channel("GR", "16", 32722, 300),
        channel("GR-ALT", "15", 32722, 300),
        channel("GR-ALT", "23"),
        channel("GR-ALT", "T23"),
        channel("GR-ALT", "24", 32741, 400),
        channel("GR-ALT", "T24", 32742, 401),
        channel("BS", "BS01_0")
    ]);
    assert.deepEqual(value.status.targets.map(item => [item.channelType, item.channel]), [
        ["GR-ALT", "T22"], ["GR-ALT", "022"], ["GR", "22"], ["GR", "16"],
        ["GR-ALT", "23"], ["GR-ALT", "24"], ["GR-ALT", "T24"]
    ]);
});

test("scheduled collection acquires each broadcast once and still runs distinct regions concurrently", async () => {
    const value = guide([channel("GR-ALT", "22"), channel("GR-ALT", "T22"), channel("GR", "22"), channel("GR-ALT", "23")]);
    const acquired = [], pending = [];
    value.collect = async request => {
        acquired.push(`${request.channelType}/${request.channel}`);
        await new Promise(resolve => pending.push(resolve));
    };
    const task = value.collectTargets(new AbortController().signal);
    await nextTurn();
    assert.deepEqual(acquired, ["GR-ALT/22", "GR/22"]);
    pending.shift()();
    await nextTurn();
    assert.deepEqual(acquired, ["GR-ALT/22", "GR/22", "GR-ALT/23"]);
    pending.splice(0).forEach(resolve => resolve());
    await task;
});

test("passive aliases share one decoder and cooldown, preserving the actual reception source", async t => {
    const value = guide([channel("GR-ALT", "22"), channel("GR-ALT", "T22"), channel("GR", "22")]);
    value.initialized = true;
    t.after(() => {
        for (const [id, session] of value.passive) { value.finishPassive(id, session); }
    });
    value.observe(11, { type: "GR-ALT", channel: "T22" }, Buffer.alloc(0));
    value.observe(7, { type: "GR-ALT", channel: "22" }, Buffer.alloc(0));
    value.observe(0, { type: "GR", channel: "22" }, Buffer.alloc(0));
    assert.equal(value.passive.size, 2);
    assert.equal(value.passive.get(11).request.channel, "T22");
    assert.equal(value.passive.has(7), false);
    value.endObservation(11);
    await nextTurn();
    assert.equal(value.passive.size, 1);
    value.observe(7, { type: "GR-ALT", channel: "22" }, Buffer.alloc(0));
    assert.equal(value.passive.size, 1, "switching tuning aliases must not bypass the cooldown");
});

test("remote-discovered GGuide service keeps its full capture window instead of an unknown-service probe", () => {
    const value = guide([channel("GR", "16")]);
    _.service = { findByChannel: () => [{ serviceId: 2199, name: "Ｇガイド" }] };
    assert.deepEqual(value.status.targets, [{ channelType: "GR", channel: "16", serviceId: 2199, durationSeconds: 1 }]);
});

test("discovery completing after a reception window acknowledges the phase captured at startup", async t => {
    const value = guide([channel("GR", "16")]);
    const startedAt = Date.parse("2026-10-24T15:35:00+09:00");
    let now = startedAt;
    t.mock.method(Date, "now", () => now);
    const { mergeGGuideReception } = require("../lib/Mirakurun/GGuideReception");
    let state = { receptionPlans: [], receptionProgress: [] };
    value.store = { get reception() { return state; }, save: async (a, b, c, d, e, update) => {
        state = mergeGGuideReception(state, update, 0);
    } };
    value.collect = async () => {
        state.receptionPlans = [{ id: "live", channelType: "GR", channel: "16", serviceId: 2199,
            receivedAt: now, windows: Array.from({ length: 24 }, (_, hour) => ({
                preferred: hour === 18, day: 0, startMinute: hour * 60, durationMinutes: 40
            })) }];
        now += 9 * 60000;
        return true;
    };
    await value.collectTargets(new AbortController().signal, true);
    const completed = state.receptionProgress.find(item => item.phase !== "discovery");
    assert.equal(completed.windowStart, Date.parse("2026-10-24T15:00:00+09:00"));
    assert.equal(completed.completedAt, now);
    assert.deepEqual(value.getAutomaticTargets(now + 3600000), []);
});

test("HTTP scheduled job with real retained TS uses one tuner for 22/T22", { timeout: 30000 }, async t => {
    const fs = require("node:fs");
    const path = require("node:path");
    const input = path.resolve("data/gguide-validation/20261023-mbs-30min/guide.ts");
    if (!fs.existsSync(input)) { t.skip("Retained broadcast sample unavailable"); return; }
    const { ProgramHistory } = require("../lib/Mirakurun/ProgramHistory");
    const Job = require("../lib/Mirakurun/Job").default;
    const Tuner = require("../lib/Mirakurun/Tuner").default;
    const Event = require("../lib/Mirakurun/Event").default;
    const { Server } = require("../lib/Mirakurun/Server");
    const history = new ProgramHistory({ path: ":memory:", integrity: "test", retentionDays: 365 });
    let server, value;
    t.after(async () => {
        _.job.close();
        await value?.close();
        await Promise.allSettled(_.tuner.devices.map(device => _.tuner.get(device.index).kill()));
        if (server) {
            for (const listener of server.servers) { listener.closeAllConnections(); }
            await server.deinit();
        }
        await history.close();
    });
    await history.open();
    guide([channel("GR-ALT", "22"), channel("GR-ALT", "T22")]);
    _.config.server = { port: 0, disableIPv6: true, disableWebUI: true, disableEITParsing: true,
        allowIPv4CidrRanges: ["127.0.0.0/8"], allowIPv6CidrRanges: [], allowOrigins: [], jobMaxRunning: 1,
        gguideDurationSeconds: 2 };
    // Inline replay uses the existing retained input; no disposable files or database copies.
    const replay = 'const fs=require("fs");const{setTimeout:sleep}=require("timers/promises");const{once}=require("events");const fd=fs.openSync(process.argv[1],"r");const b=Buffer.alloc(188*256);let p=0;(async()=>{for(;;){const n=fs.readSync(fd,b,0,b.length,p);if(!n){p=0;continue;}p+=n;if(!process.stdout.write(Buffer.from(b.subarray(0,n))))await once(process.stdout,"drain");await sleep(1);}})();process.stdout.on("error",()=>process.exit());';
    const command = `${process.execPath} -e '${replay}' ${input}`;
    _.config.tuners = ["J", "AME"].map(name => ({ name, types: ["GR-ALT"], command }));
    _.program = { history, itemMap: new Map() };
    _.service = { items: [], findByChannel: () => [] };
    _.event = new Event();
    _.job = new Job();
    _.tuner = new Tuner();
    value = _.gguide = new GGuide();
    await value.init();
    server = _.server = new Server(); server.testMode = true;
    await server.init();
    const base = `http://127.0.0.1:${[...server.servers][0].address().port}/api`;
    const statusResponse = await fetch(`${base}/gguide`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.deepEqual(status.targets, [{ channelType: "GR-ALT", channel: "22", durationSeconds: 2 }]);
    assert.equal(status.available, true);
    const run = await fetch(`${base}/job-schedules/gguide%3Ascheduled/run`, { method: "PUT" });
    assert.equal(run.status, 202, await run.text());
    let job, observed = false;
    for (let i = 0; i < 100; i++) {
        const tunerResponse = await fetch(`${base}/tuners`);
        assert.equal(tunerResponse.status, 200);
        const users = (await tunerResponse.json()).flatMap(device => device.users).filter(user => user.id === "Mirakurun:GGuide");
        assert.ok(users.length <= 1, "22/T22 must never consume two tuner streams");
        observed ||= users.length === 1;
        const jobsResponse = await fetch(`${base}/jobs`);
        assert.equal(jobsResponse.status, 200);
        job = (await jobsResponse.json()).find(item => item.key === "gguide:scheduled");
        if (job?.status === "finished") { break; }
        await sleep(100);
    }
    assert.equal(observed, true);
    assert.equal(job?.status, "finished");
    assert.equal(job.hasFailed, false, job.error);
    const assetsResponse = await fetch(`${base}/gguide/assets`);
    assert.equal(assetsResponse.status, 200);
    const assets = await assetsResponse.json();
    assert.ok(assets.length > 10, "the retained TS must still decode and publish images");
    assert.ok(assets.every(asset => asset.sources.every(source => source.channel === "22")));
    const persisted = await history.gguideOpen(value.store.maxBytes);
    assert.ok(persisted.receptionPlans.length > 0, "the real decoder must learn HIP plans without retaining raw modules");
    assert.ok(persisted.receptionPlans.every(plan => plan.channel === "22"));
    await value.close();
    _.job.close();
    _.job = new Job();
    value = _.gguide = new GGuide();
    await value.init();
    assert.deepEqual(value.store.reception.receptionPlans, persisted.receptionPlans, "cold GGuide startup must load SQLite plans");
    // Exercise the automatic schedule branch through the real Job runner, not manual Run.
    const due = value.getAutomaticTargets();
    if (due.length) {
        const prior = _.job.jobs.length;
        await _.job._checkSchedule();
        let automatic;
        for (let i = 0; i < 100; i++) {
            automatic = _.job.jobs.find(item => item.key === "gguide:scheduled");
            if (automatic?.status === "finished") { break; }
            await sleep(100);
        }
        assert.ok(_.job.jobs.length > prior);
        assert.equal(automatic?.hasFailed, false, automatic?.error);
        assert.ok(value.store.reception.receptionProgress.some(item => item.completedAt));
        const count = _.job.jobs.length;
        await _.job._checkSchedule();
        assert.equal(_.job.jobs.length, count, "a completed window must not enqueue another automatic capture");
    }
});
