// Explicit live acceptance. Retained output: <=64 MiB, including SQLite and logs.
// GGUIDE_LIVE_HOST=... GGUIDE_LIVE_DIR=... node --test test/gguide-live.spec.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: sleep } = require("node:timers/promises");

test("local server discovers remote channels and automatically learns live reception plans", {
    skip: !process.env.GGUIDE_LIVE_HOST, timeout: 900000
}, async t => {
    const root = path.resolve(process.env.GGUIDE_LIVE_DIR);
    assert.ok(root.startsWith(path.resolve("data/gguide-validation") + path.sep));
    fs.mkdirSync(root, { recursive: true });
    const bytes = dir => fs.readdirSync(dir, { withFileTypes: true }).reduce((sum, entry) => {
        const name = path.join(dir, entry.name);
        return sum + (entry.isDirectory() ? bytes(name) : fs.statSync(name).size);
    }, 0);
    assert.ok(bytes(root) < 64 * 1024 * 1024);
    Object.assign(process.env, {
        SERVICES_DB_PATH: path.join(root, "services.json"), CHANNELS_DB_PATH: path.join(root, "channels.json"),
        PROGRAM_HISTORY_DB_PATH: path.join(root, "programs.sqlite"), PROGRAMS_DB_PATH: path.join(root, "programs.json"),
        LOGO_DATA_DIR_PATH: path.join(root, "logos")
    });
    const statusPath = require.resolve("../lib/Mirakurun/status");
    require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true,
        exports: { __esModule: true, default: { streamCount: { tsFilter: 0, decoder: 0 }, epg: {}, errorCount: {
            uncaughtException: 0, unhandledRejection: 0, bufferOverflow: 0, tunerDeviceRespawn: 0, decoderRespawn: 0
        } } } };
    const _ = require("../lib/Mirakurun/_").default;
    const log = require("../lib/Mirakurun/log");
    log.logLevel = 1;
    const Job = require("../lib/Mirakurun/Job").default;
    const Tuner = require("../lib/Mirakurun/Tuner").default;
    const Channel = require("../lib/Mirakurun/Channel").default;
    const Service = require("../lib/Mirakurun/Service").default;
    const Program = require("../lib/Mirakurun/Program").default;
    const Event = require("../lib/Mirakurun/Event").default;
    const Server = require("../lib/Mirakurun/Server").default;
    const GGuide = require("../lib/Mirakurun/GGuide").default;
    const durationSeconds = Number(process.env.GGUIDE_LIVE_DURATION_SECONDS || 180);
    assert.ok(Number.isInteger(durationSeconds) && durationSeconds >= 30 && durationSeconds <= 600);
    _.config.server = { port: 0, disableIPv6: true, disableWebUI: true, disableEITParsing: true,
        allowIPv4CidrRanges: ["127.0.0.0/8"], allowIPv6CidrRanges: [], allowOrigins: [], jobMaxRunning: 2,
        gguideSchedule: "auto", gguideDurationSeconds: durationSeconds, gguideMaxStorageBytes: 32 * 1024 * 1024 };
    _.config.channels = [];
    _.configIntegrity.channels = "gguide-reception-live-v1";
    _.config.tuners = [1, 2].map(index => ({ name: `Live reception validation ${index}`, types: ["GR"],
        remoteMirakurunHost: process.env.GGUIDE_LIVE_HOST, remoteMirakurunPort: Number(process.env.GGUIDE_LIVE_PORT || 40772) }));
    _.event = new Event(); _.job = new Job(); _.tuner = new Tuner(); _.channel = new Channel(); _.service = new Service(); _.program = new Program();
    let server;
    const budget = setInterval(() => {
        if (bytes(root) >= 64 * 1024 * 1024) {
            _.job.close();
            for (const device of _.tuner.devices) { void _.tuner.get(device.index).kill(); }
        }
    }, 1000);
    t.after(async () => {
        clearInterval(budget);
        _.job.close();
        await _.gguide?.close();
        await Promise.allSettled(_.tuner.devices.map(device => _.tuner.get(device.index).kill()));
        if (server) {
            for (const listener of server.servers) { listener.closeAllConnections(); }
            await server.deinit();
        }
        clearTimeout(_.service._saveTimerId); clearTimeout(_.channel._saveTimerId);
        await _.program.close();
        assert.ok(bytes(root) < 64 * 1024 * 1024, "retained acceptance output budget");
    });
    await _.channel.load(); await _.service.load(); await _.program.load();
    _.gguide = new GGuide(); await _.gguide.init();
    server = _.server = new Server(); server.testMode = true; await server.init();
    const base = `http://127.0.0.1:${[...server.servers][0].address().port}/api`;
    const json = async endpoint => {
        const response = await fetch(base + endpoint, { signal: AbortSignal.timeout(10000) });
        const body = await response.text();
        assert.equal(response.status, 200, endpoint + ": " + body);
        return JSON.parse(body);
    };
    const before = await json("/gguide");
    assert.equal(before.available, true); assert.equal(before.schedule, "auto");
    let channels;
    for (let i = 0; i < 40; i++) {
        channels = await json("/channels");
        if (channels.some(channel => channel.services.some(service => /ガイド/.test(service.name)))) { break; }
        await sleep(500);
    }
    assert.ok(channels.length > 1, "remote service sync must discover channels from an empty configuration");
    assert.ok(channels.some(channel => channel.services.some(service => /ガイド/.test(service.name))));
    const services = await json("/services");
    console.log(JSON.stringify({ stage: "discovered", base, channelCount: channels.length, serviceCount: services.length,
        targets: (await json("/gguide")).targets }));
    const schedules = await json("/job-schedules");
    assert.equal(schedules.find(item => item.key === "gguide:scheduled").schedule, "* * * * *");
    const initialTargets = _.gguide.getAutomaticTargets();
    await _.job._checkSchedule(); // The real automatic tick, with no manual collection POST or target list.
    let job, peakUsers = 0;
    for (let i = 0; i < 850; i++) {
        const tuners = await json("/tuners");
        const users = tuners.flatMap(device => device.users).filter(user => user.id === "Mirakurun:GGuide");
        peakUsers = Math.max(peakUsers, users.length);
        assert.ok(users.length <= 2);
        assert.ok(users.every(user => user.priority === -1));
        job = (await json("/jobs")).find(item => item.key === "gguide:scheduled");
        if (!initialTargets.length) { assert.equal(job, undefined, "restart outside advertised windows must not start a capture"); break; }
        if (job?.status === "finished") { break; }
        if (i % 30 === 0) {
            const current = await json("/gguide");
            console.log(JSON.stringify({ stage: "collecting", at: new Date().toISOString(), users: users.length,
                assetCount: current.assetCount, plans: _.gguide.store.reception.receptionPlans.length }));
        }
        await sleep(1000);
    }
    if (initialTargets.length) {
        assert.equal(job?.status, "finished"); assert.equal(job.hasFailed, false, job.error);
        assert.ok(peakUsers > 0);
    }
    const assets = await json("/gguide/assets");
    const bindings = await json("/gguide/bindings");
    const state = await _.program.history.gguideOpen(_.gguide.store.maxBytes);
    assert.ok(state.receptionPlans.length > 0, "live HIP plans must be persisted");
    const { dueGGuideReception } = require("../lib/Mirakurun/GGuideReception");
    for (const item of state.receptionProgress.filter(item => item.phase === "discovery" && item.completedAt)) {
        const plans = state.receptionPlans.filter(plan => plan.channelType === item.channelType && plan.channel === item.channel);
        if (!plans.length) { continue; }
        const slot = dueGGuideReception({ ...item, durationSeconds }, plans, [], item.attemptedAt);
        if (slot && slot.phase !== "discovery") {
            assert.ok(state.receptionProgress.some(progress => progress.channelType === item.channelType && progress.channel === item.channel &&
                progress.phase === slot.phase && progress.cycle === slot.cycle && progress.completedAt), "successful discovery must acknowledge its received phase");
        }
    }
    assert.ok(assets.length > 0); assert.ok(bindings.length > 0);
    const image = await fetch(`${base}/gguide/assets/${assets.find(asset => asset.displayable).id}`);
    assert.equal(image.status, 200); assert.ok((await image.arrayBuffer()).byteLength > 0);
    const oldPlans = _.gguide.store.reception.receptionPlans;
    const oldAssets = assets.map(asset => asset.id);
    await _.gguide.close(); _.job.close(); _.job = new Job();
    _.gguide = new GGuide(); await _.gguide.init();
    assert.deepEqual(_.gguide.store.reception.receptionPlans, oldPlans);
    assert.deepEqual(_.gguide.store.reception.receptionProgress, state.receptionProgress);
    assert.deepEqual((await json("/gguide/assets")).map(asset => asset.id), oldAssets);
    assert.equal((await json("/gguide")).schedule, "auto");
    const completed = state.receptionProgress.filter(item => item.phase !== "discovery" && item.completedAt);
    assert.ok(_.gguide.getAutomaticTargets().every(slot => !completed.some(item =>
        item.channelType === slot.request.channelType && item.channel === slot.request.channel && item.phase === slot.phase && item.cycle === slot.cycle)));
    const report = { checkedAt: new Date().toISOString(), base, remoteHost: process.env.GGUIDE_LIVE_HOST,
        channelCount: channels.length, serviceCount: services.length, peakCollectorUsers: peakUsers,
        job, dueAtStartup: initialTargets.length, assetCount: assets.length, bindingCount: bindings.length, planCount: state.receptionPlans.length,
        completed, restarted: true, outputBytes: bytes(root) };
    fs.writeFileSync(path.join(root, "acceptance.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
});
