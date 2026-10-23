// Optional acceptance against retained broadcast input. No key or firmware is
// distributed with this test. Run with GGUIDE_REAL_CAPTURE=1 and an empty,
// retained GGUIDE_VALIDATION_DIR (budget: 64 MiB including logs).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { setTimeout: sleep } = require("node:timers/promises");
const { createHash } = require("node:crypto");

const sha = data => createHash("sha256").update(data).digest("hex");
const inputRoot = path.resolve("data/gguide-validation");

function fixtureKey() {
    const root = path.join(inputRoot, "20261024-panasonic");
    const elf = fs.readFileSync(path.join(root, "selected/usr/local/bin/ggsvr"));
    const phoff = elf.readUInt32LE(28);
    const size = elf.readUInt16LE(42);
    const count = elf.readUInt16LE(44);
    let prefix;
    for (let i = 0; i < count; i++) {
        const start = phoff + i * size;
        const offset = elf.readUInt32LE(start + 4);
        const va = elf.readUInt32LE(start + 8);
        const length = elf.readUInt32LE(start + 16);
        if (elf.readUInt32LE(start) === 1 && va <= 0x2d3dc && va + length >= 0x2d3e2) {
            prefix = Buffer.from([...elf.subarray(offset + 0x2d3dc - va, offset + 0x2d3e2 - va)].map(x => x ^ 255));
        }
    }
    assert.ok(prefix);
    const suffix = JSON.parse(fs.readFileSync(path.join(root, "des-suffix-probe.json"))).matches[0].suffix;
    const key = Buffer.alloc(8);
    prefix.copy(key);
    key.writeUInt16BE(typeof suffix === "number" ? suffix : parseInt(suffix, 16), 6);
    return key.toString("hex");
}

test("real TS -> actual tuner/Job/HTTP -> persistent materials; cancellation, preemption and wrong-key isolation", {
    skip: process.env.GGUIDE_REAL_CAPTURE !== "1", timeout: 90000
}, async () => {
    const root = path.resolve(process.env.GGUIDE_VALIDATION_DIR);
    assert.ok(root.startsWith(inputRoot + path.sep));
    fs.mkdirSync(root, { recursive: true });
    assert.equal(fs.existsSync(path.join(root, "store")), false, "Use a fresh retained acceptance directory");
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
    const key = fixtureKey();
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
    _.program = { history: { flush: async () => undefined } };
    let server;
    const options = { directory: path.join(root, "store"), key, maxBytes: 16 * 1024 * 1024, preserveModules: true };
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
        const modules = fs.readdirSync(path.join(options.directory, "modules"));
        assert.ok(modules.length > 0);
        const before = fs.readFileSync(path.join(options.directory, "index.json"));
        // Reject an oversized publication atomically, preserving the same index.
        const GGuideStore = require("../lib/Mirakurun/GGuideStore").default;
        const boundedStore = new GGuideStore(options.directory, before.length);
        await boundedStore.init();
        await assert.rejects(boundedStore.save([], new Map(), { status: "completed" }), /budget exhausted/);
        assert.deepEqual(fs.readFileSync(path.join(options.directory, "index.json")), before);
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
        _.gguide = new GGuide({ ...options, key: "0000000000000000" });
        await _.gguide.init();
        const badKeyJob = await collect(3);
        assert.equal((await finished(badKeyJob.id)).hasFailed, true);
        assert.deepEqual(await json("/gguide/assets"), assets);
        assert.deepEqual(fs.readFileSync(path.join(options.directory, "index.json")), before);
        await _.gguide.close();
        await closeHTTP();
        await start();
        assert.deepEqual(await json("/gguide/assets"), assets);
        assert.equal((await json("/gguide")).lastCollection.status, "completed");
        const report = { assetCount: assets.length, displayable: content.length, preservedModules: modules.length,
            job: done, contentHashes: content, restart: true, abort: true, preemption: true, wrongKeyPreservesMaterials: true };
        // The same HTTP collector must omit raw modules when preservation is off.
        await _.gguide.close();
        _.gguide = new GGuide({ ...options, directory: path.join(root, "images-only"), preserveModules: false });
        await _.gguide.init();
        const imagesOnlyJob = await collect(3);
        const imagesOnlyDone = await finished(imagesOnlyJob.id);
        assert.equal(imagesOnlyDone.hasFailed, false, imagesOnlyDone.error);
        assert.equal(fs.readdirSync(path.join(root, "images-only/modules")).length, 0);
        assert.ok((await json("/gguide/assets")).length > 0);
        report.optionalModulePreservation = true;
        report.bindingCount = bindings.length;
        await _.gguide.close();
        _.config.server.gguideTargets = [{ channelType: "GR", channel: "16", serviceId: 2199, durationSeconds: 5 }];
        _.gguide = new GGuide({ ...options, directory: path.join(root, "automated") });
        await _.gguide.init();
        const schedules = await json("/job-schedules");
        const schedule = schedules.find(item => item.key === "gguide:scheduled");
        assert.equal(schedule.job.name, "GGuide Gatherer");
        assert.equal(schedule.schedule, "20 5,11,17,23 * * *");
        const dispatch = await fetch(`${base}/job-schedules/gguide%3Ascheduled/run`, { method: "PUT" });
        assert.equal(dispatch.status, 202, await dispatch.text());
        const scheduledJob = (await json("/jobs")).find(item => item.key === "gguide:scheduled" && item.status !== "finished");
        assert.ok(scheduledJob);
        assert.equal((await finished(scheduledJob.id)).hasFailed, false);
        assert.ok((await json("/gguide/assets")).length > 10);
        // Use a fresh store and real viewer-owned tuner; no collector user exists.
        await _.gguide.close();
        _.config.server.gguideSchedule = "";
        _.config.server.gguideTargets[0].durationSeconds = 30;
        _.gguide = new GGuide({ ...options, directory: path.join(root, "passive") });
        await _.gguide.init();
        const viewerSink = new Writable({ write(chunk, encoding, callback) { callback(); } });
        const viewer = await _.channel.get("GR", "16").getStream({ id: "passive-validation-viewer", priority: 0, disableDecoder: true }, viewerSink);
        await sleep(5000);
        assert.equal((await json("/gguide")).passiveCollections, 1);
        const users = _.tuner.devices.flatMap(device => device.users);
        assert.equal(users.filter(user => user.id === "passive-validation-viewer").length, 1);
        assert.ok(!users.some(user => user.id === "Mirakurun:GGuide"));
        viewer.close();
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
        assert.equal(fs.readdirSync(path.join(root, "passive/assets")).length, passiveAssets.length);
        report.concurrentDedup = true;
        await _.gguide.store.prune(Date.now() + 7 * 86400000 + 1000);
        assert.deepEqual(await json("/gguide/assets"), []);
        assert.deepEqual(await json("/gguide/bindings"), []);
        await json(`/gguide/assets/${passiveAssets[0].id}`, 404);
        assert.deepEqual(fs.readdirSync(path.join(root, "passive/modules")), []);
        assert.deepEqual(fs.readdirSync(path.join(root, "passive/assets")), []);
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
    }
});
