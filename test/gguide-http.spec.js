// Optional acceptance against retained broadcast input using the built-in decoder. Run with GGUIDE_REAL_CAPTURE=1 and an empty,
// retained GGUIDE_VALIDATION_DIR (budget: 64 MiB including logs).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: sleep } = require("node:timers/promises");
const { createHash } = require("node:crypto");

const sha = data => createHash("sha256").update(data).digest("hex");
const inputRoot = path.resolve("data/gguide-validation");


test("real TS -> actual tuner/Job/HTTP -> persistent materials; cancellation and preemption", {
    skip: process.env.GGUIDE_REAL_CAPTURE !== "1", timeout: 90000
}, async () => {
    const root = path.resolve(process.env.GGUIDE_VALIDATION_DIR);
    assert.ok(root.startsWith(inputRoot + path.sep));
    fs.mkdirSync(root, { recursive: true });
    assert.equal(fs.existsSync(path.join(root, "store.sqlite")), false, "Use a fresh retained acceptance directory");
    // Cancel import-time status sampling in this standalone test process; its
    // recursive timer is normally owned by the long-running server process.
    const nativeSetTimeout = global.setTimeout;
    const importTimers = [];
    global.setTimeout = (...args) => { const timer = nativeSetTimeout(...args); importTimers.push(timer); return timer; };
    let Server;
    try { ({ Server } = require("../lib/Mirakurun/Server")); } finally {
        global.setTimeout = nativeSetTimeout;
        importTimers.forEach(clearTimeout);
    }
    const _ = require("../lib/Mirakurun/_").default;
    const GGuide = require("../lib/Mirakurun/GGuide").default;
    const Job = require("../lib/Mirakurun/Job").default;
    const Tuner = require("../lib/Mirakurun/Tuner").default;
    const Channel = require("../lib/Mirakurun/Channel").default;
    const Event = require("../lib/Mirakurun/Event").default;
    const { Writable } = require("node:stream");
    const replay = path.join(root, "replay-input.cjs");
    // A real child-process tuner. Loops the unchanged retained TS so the capture
    // timer, not artificial EOF, owns completion. Bounded read buffer: 188*256.
    fs.writeFileSync(replay, `const fs=require("node:fs");
const {once}=require("node:events"); const {setTimeout:sleep}=require("node:timers/promises");
const input=fs.openSync(process.argv[2],"r"); const buffer=Buffer.alloc(188*256); let offset=0;
(async()=>{while(true){ const count=fs.readSync(input,buffer,0,buffer.length,offset);
if(!count){offset=0;continue;} offset+=count;
if(!process.stdout.write(Buffer.from(buffer.subarray(0,count)))) await once(process.stdout,"drain"); await sleep(1); }})().catch(()=>process.exit(0));
process.stdout.on("error",()=>process.exit(0));
`);
    _.config.server = { port: 0, disableIPv6: true, disableWebUI: true, disableEITParsing: true,
        allowIPv4CidrRanges: ["127.0.0.0/8"], allowIPv6CidrRanges: [], allowOrigins: [], jobMaxRunning: 1 };
    _.config.channels = [{ type: "GR", channel: "16", name: "MBS real capture" },
        { type: "GR", channel: "17", name: "Foreground preemption" }];
    _.config.tuners = [{ name: "Retained TS tuner", types: ["GR"],
        command: `${process.execPath} ${replay} ${path.join(inputRoot, "20261023-mbs-30min/guide.ts")}` }];
    _.event = new Event();
    _.job = new Job();
    _.tuner = new Tuner();
    _.channel = new Channel();
    _.service = { items: [], findByChannel: () => [] };
    const { ProgramHistory } = require("../lib/Mirakurun/ProgramHistory");
    const openHistory = async name => {
        await _.program?.history?.close();
        const history = new ProgramHistory({ path: path.join(root, name + ".sqlite"), integrity: "validation", retentionDays: 365 });
        await history.open();
        _.program = { history };
    };
    await openHistory("store");
    let server;
    const options = { maxBytes: 16 * 1024 * 1024, preserveModules: true };
    let base;
    const start = async () => {
        _.gguide = new GGuide(options);
        await _.gguide.init();
        assert.equal(_.gguide.status.available, true);
        server = new Server(); server.testMode = true; _.server = server;
        await server.init();
        base = `http://127.0.0.1:${[...server.servers][0].address().port}/api`;
    };
    const json = async (url, expected = 200, body) => {
        const response = await fetch(base + url, body === undefined ? {} : {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
        });
        const text = await response.text();
        assert.equal(response.status, expected, `${url}: ${text}`);
        return JSON.parse(text);
    };
    const finished = async id => {
        for (let i = 0; i < 150; i++) {
            const job = (await json("/jobs")).find(j => j.id === id);
            if (job?.status === "finished") { return job; }
            await sleep(100);
        }
        assert.fail("Collection did not finish within 15 seconds");
    };
    const collect = durationSeconds => json("/gguide/collections", 200, { channelType: "GR", channel: "16", serviceId: 2199, durationSeconds });
    const closeHTTP = async () => {
        if (!server) { return; }
        for (const listener of server.servers) { listener.closeAllConnections(); }
        await server.deinit();
    };
    try {
        await start();
        assert.deepEqual(await json("/gguide/assets"), []);
        assert.equal((await json("/gguide")).keyConfigured, true);
        await json("/gguide/collections", 400, { source: "/etc/passwd" });
        const job = await collect(5);
        await sleep(3000);
        assert.equal((await json("/jobs")).find(item => item.id === job.id).status, "running");
        const liveAssets = await json("/gguide/assets");
        assert.ok(liveAssets.length > 0, "Complete assets must be visible before capture ends");
        assert.ok((await json("/gguide/bindings")).length > 0);
        assert.equal((await json("/gguide")).lastCollection, undefined);
        const liveImage = await fetch(`${base}/gguide/assets/${liveAssets[0].id}`);
        assert.equal(liveImage.status, 200);
        assert.equal(sha(Buffer.from(await liveImage.arrayBuffer())), liveAssets[0].id);
        await json("/gguide/collections", 409, { channelType: "GR", channel: "16", serviceId: 2199 });
        const done = await finished(job.id);
        assert.equal(done.hasFailed, false, done.error);
        const assets = await json("/gguide/assets");
        assert.ok(assets.length > 10, `Expected real images, got ${assets.length}`);
        const bindings = await json("/gguide/bindings");
        assert.ok(bindings.some(binding => binding.kind === "nap" && binding.members.some(member => member.role === "top" && member.assetId)));
        assert.ok(bindings.some(binding => binding.kind === "nap" && binding.members.some(member => member.role === "detailImage" && member.assetId && member.uri)));
        assert.ok(bindings.some(binding => binding.kind === "pap"));
        assert.ok(bindings.some(binding => binding.kind === "obj12" && binding.members.some(member => member.assetId && member.uri)));
        for (const binding of bindings) {
            assert.equal(binding.channel, "16");
            assert.equal(binding.serviceId, 2199);
            for (const member of binding.members) {
                if (member.assetId) { assert.ok(assets.some(asset => asset.id === member.assetId)); }
            }
        }
        const content = [];
        for (const asset of assets) {
            assert.equal(asset.displayEligibility, "unknown");
            assert.ok(asset.sources.length);
            assert.equal(asset.sources[0].channel, "16");
            assert.equal(asset.sources[0].serviceId, 2199);
            const response = await fetch(`${base}/gguide/assets/${asset.id}`);
            if (!asset.displayable) { assert.equal(response.status, 422); await response.arrayBuffer(); continue; }
            assert.equal(response.status, 200);
            assert.equal(response.headers.get("content-type"), asset.mimeType);
            const bytes = Buffer.from(await response.arrayBuffer());
            assert.equal(sha(bytes), asset.id);
            assert.equal(bytes.length, asset.size);
            content.push(asset.id);
        }
        await json(`/gguide/assets/${"0".repeat(64)}`, 404);
        const before = await _.program.history.gguideOpen(options.maxBytes);
        const modules = before.modules;
        assert.ok(modules.length > 0);
        await assert.rejects(_.program.history.gguideSave({ materials: [], modules: [], bindings: [],
            result: { status: "completed" }, maxBytes: 1 }), /budget exhausted/);
        assert.deepEqual(await _.program.history.gguideOpen(options.maxBytes), before);
        const abortJob = await collect(30);
        const aborted = await fetch(`${base}/jobs/${abortJob.id}/abort`, { method: "PUT" });
        assert.equal(aborted.status, 202, await aborted.text());
        assert.equal((await finished(abortJob.id)).hasAborted, true);
        assert.deepEqual(await json("/gguide/assets"), assets);
        const preemptJob = await collect(30);
        await sleep(200);
        const sink = new Writable({ write(chunk, encoding, callback) { callback(); } });
        const foreground = await _.channel.get("GR", "17").getStream({ id: "validation-viewer", priority: 0, disableDecoder: true }, sink);
        assert.equal((await finished(preemptJob.id)).hasFailed, true);
        foreground.close();
        assert.deepEqual(await json("/gguide/assets"), assets);
        await _.gguide.close();
        await closeHTTP();
        await openHistory("store");
        await start();
        assert.deepEqual(await json("/gguide/assets"), assets);
        assert.equal((await json("/gguide")).lastCollection.status, "completed");
        const report = { assetCount: assets.length, displayable: content.length, preservedModules: modules.length,
            job: done, contentHashes: content, restart: true, abort: true, preemption: true };
        // The same HTTP collector must omit raw modules when preservation is off.
        await _.gguide.close();
        await openHistory("images-only");
        _.gguide = new GGuide({ ...options, preserveModules: false });
        await _.gguide.init();
        const imagesOnlyJob = await collect(3);
        const imagesOnlyDone = await finished(imagesOnlyJob.id);
        assert.equal(imagesOnlyDone.hasFailed, false, imagesOnlyDone.error);
        assert.equal((await _.program.history.gguideOpen(options.maxBytes)).modules.length, 0);
        assert.ok((await json("/gguide/assets")).length > 0);
        report.optionalModulePreservation = true;
        report.bindingCount = bindings.length;
        await _.gguide.close();
        _.job.close();
        _.job = new Job();
        _.config.server.gguideDurationSeconds = 5;
        await Promise.allSettled(_.tuner.devices.map(device => _.tuner.get(device.index).kill()));
        _.config.tuners.push({ ..._.config.tuners[0], name: "Second retained TS tuner" });
        _.tuner = new Tuner();
        await openHistory("automated");
        _.gguide = new GGuide({ ...options });
        await _.gguide.init();
        assert.equal((await json("/gguide")).enabled, true);
        for (const enabled of [false, true]) {
            const response = await fetch(base + "/gguide", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
            assert.equal(response.status, 200);
            assert.equal((await response.json()).enabled, enabled);
            assert.equal((await _.program.history.gguideOpen(options.maxBytes)).enabled, enabled);
        }
        const schedules = await json("/job-schedules");
        const schedule = schedules.find(item => item.key === "gguide:scheduled");
        assert.equal(schedule.job.name, "HGuide Getherer");
        assert.equal(schedule.schedule, "20 5,11,17,23 * * *");
        const dispatch = await fetch(`${base}/job-schedules/gguide%3Ascheduled/run`, { method: "PUT" });
        assert.equal(dispatch.status, 202, await dispatch.text());
        const scheduledJob = (await json("/jobs")).find(item => item.key === "gguide:scheduled" && item.status !== "finished");
        assert.ok(scheduledJob);
        await sleep(2500);
        assert.equal(_.tuner.devices.flatMap(device => device.users).filter(user => user.id === "Mirakurun:GGuide").length, 2,
            "Schedule execution must acquire two tuner streams concurrently");
        assert.equal((await finished(scheduledJob.id)).hasFailed, false);
        assert.ok((await json("/gguide/assets")).length > 10);
        // Use a fresh store and real viewer-owned tuner; no collector user exists.
        await _.gguide.close();
        _.config.server.gguideSchedule = "";
        _.config.server.gguideDurationSeconds = 30;
        await openHistory("passive");
        await Promise.allSettled(_.tuner.devices.map(device => _.tuner.get(device.index).kill()));
        _.tuner = new Tuner();
        _.gguide = new GGuide({ ...options });
        await _.gguide.init();
        const viewerSink = new Writable({ write(chunk, encoding, callback) { callback(); } });
        const viewer = await _.channel.get("GR", "16").getStream({ id: "passive-validation-viewer", priority: 0, disableDecoder: true }, viewerSink);
        const secondSink = new Writable({ write(chunk, encoding, callback) { callback(); } });
        const secondViewer = await _.channel.get("GR", "17").getStream({ id: "second-passive-viewer", priority: 0, disableDecoder: true }, secondSink);
        await sleep(5000);
        assert.equal((await json("/gguide")).passiveCollections, 2);
        const users = _.tuner.devices.flatMap(device => device.users);
        assert.equal(users.filter(user => user.id === "passive-validation-viewer").length, 1);
        assert.ok(!users.some(user => user.id === "Mirakurun:GGuide"));
        assert.ok((await json("/gguide/assets")).length > 0, "Passive capture publishes while viewer remains connected");
        const simultaneousAssets = await json("/gguide/assets");
        assert.ok(simultaneousAssets.some(asset => asset.sources.some(source => source.channel === "16") && asset.sources.some(source => source.channel === "17")));
        const simultaneousBindings = await json("/gguide/bindings");
        assert.ok(simultaneousBindings.some(binding => binding.channel === "16"));
        assert.ok(simultaneousBindings.some(binding => binding.channel === "17"));
        viewer.close();
        await sleep(100);
        assert.equal((await json("/gguide")).passiveCollections, 1);
        assert.ok(_.tuner.devices.flatMap(device => device.users).some(user => user.id === "second-passive-viewer"));
        secondViewer.close();
        report.simultaneousSources = true;
        await Promise.allSettled(_.tuner.devices.map(device => _.tuner.get(device.index).kill()));
        for (let i = 0; i < 50 && !(await json("/gguide/assets")).length; i++) { await sleep(100); }
        const passiveAssets = await json("/gguide/assets");
        assert.ok(passiveAssets.length > 10);
        assert.ok((await json("/gguide/bindings")).length > 0);
        assert.equal((await json("/gguide")).passiveCollections, 0);
        assert.equal(_.tuner.devices.flatMap(device => device.users).length, 0);
        const passiveBindings = await json("/gguide/bindings");
        const material = await _.gguide.store.read(passiveAssets[0].id);
        const refreshedAt = Date.now();
        material.asset.lastReceivedAt = refreshedAt;
        material.asset.sources.forEach(source => { source.lastReceivedAt = refreshedAt; });
        const renewedBindings = passiveBindings.map(binding => ({ ...binding, lastReceivedAt: refreshedAt }));
        const result = { ..._.gguide.store.lastCollection, finishedAt: refreshedAt };
        await Promise.all([
            _.gguide.store.save([material], new Map(), result, renewedBindings),
            _.gguide.store.save([material], new Map(), result, renewedBindings)
        ]);
        const renewedAssets = await json("/gguide/assets");
        assert.equal(renewedAssets.length, passiveAssets.length);
        assert.equal(renewedAssets.find(asset => asset.id === material.asset.id).lastReceivedAt, refreshedAt);
        assert.equal((await json("/gguide/bindings")).length, passiveBindings.length);
        assert.equal((await _.program.history.gguideOpen(options.maxBytes)).assets.length, passiveAssets.length);
        report.concurrentDedup = true;
        await _.gguide.store.prune(Date.now() + 7 * 86400000 + 1000);
        assert.deepEqual(await json("/gguide/assets"), []);
        assert.deepEqual(await json("/gguide/bindings"), []);
        await json(`/gguide/assets/${passiveAssets[0].id}`, 404);
        assert.deepEqual((await _.program.history.gguideOpen(options.maxBytes)).modules, []);
        assert.deepEqual((await _.program.history.gguideOpen(options.maxBytes)).assets, []);
        report.scheduleDispatch = true;
        report.passiveWithoutOwnership = true;
        report.sevenDayExpiry = true;
        report.storageBudgetIsolation = true;
        fs.writeFileSync(path.join(root, "acceptance.json"), JSON.stringify(report, null, 2));
        console.log(JSON.stringify(report));
    } finally {
        _.job.close();
        await _.gguide?.close();
        await Promise.allSettled(_.tuner.devices.map(d => _.tuner.get(d.index).kill()));
        await closeHTTP();
        await _.program?.history?.close();
    }
});
