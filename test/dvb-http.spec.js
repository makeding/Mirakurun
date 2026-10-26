/*
   Copyright 2026 kanreisa

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
const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const cp = require("node:child_process");
const yaml = require("js-yaml");

// Only two small YAML configurations are written, at this exact owned path.
// The test cleanup runs on failure, success, timeout and the UI mode signals.
const directory = "/private/tmp/mirakurun-dvb-http-acceptance";
const uiMode = process.env.MIRAKURUN_DVB_UI_ACCEPTANCE === "1";
process.env.TUNERS_CONFIG_PATH = `${directory}/tuners.yml`;
const shared = require("../lib/Mirakurun/_").default;
const Event = require("../lib/Mirakurun/Event").default;
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true,
    exports: { __esModule: true, default: {
        rpcCount: 0, epg: {}, streamCount: { tsFilter: 0, decoder: 0 },
        errorCount: { tunerDeviceRespawn: 0 }, timerAccuracy: { last: 0, m1: [0], m5: [0], m15: [0] }
    } } };
const config = require("../lib/Mirakurun/config");
const Tuner = require("../lib/Mirakurun/Tuner").default;
const { Channel } = require("../lib/Mirakurun/Channel");
const Service = require("../lib/Mirakurun/Service").default;
const { Server } = require("../lib/Mirakurun/Server");

test("DVB configurations persist through real HTTP and frontend leases serve channel streams", { timeout: uiMode ? 600000 : 20000 }, async t => {
    assert.equal(fs.existsSync(directory), false, `remove the stale owned directory before rerun: ${directory}`);
    fs.mkdirSync(directory);
    const server = new Server();
    const requests = [];
    t.after(async () => {
        try {
            for (const controller of requests) { controller.abort(); }
            for (const device of shared.tuner?._devices || []) {
                if (device.pid) { await device.kill(); }
            }
            for (const listener of server.servers) { listener.closeAllConnections(); }
            if (server.isRunning) { await server.deinit(); }
        } finally {
            const bytes = fs.readdirSync(directory).reduce((sum, file) => sum + fs.statSync(`${directory}/${file}`).size, 0);
            fs.rmSync(directory, { recursive: true });
            assert.equal(fs.existsSync(directory), false);
            console.log(`DVB acceptance cleanup: removed ${bytes} bytes from ${directory} (budget 1048576 bytes)`);
            assert.ok(bytes <= 1048576);
        }
    });
    const automatic = {
        name: "DVB-GR", types: ["GR"], dvbAutoDiscovery: true,
        command: `${process.execPath} -e "const b=Buffer.alloc(188*32,255);for(let i=0;i<b.length;i+=188){b[i]=71;b[i+1]=0;b[i+2]=20;b[i+3]=16}setInterval(()=>process.stdout.write(b),20)" <dvbAdapter> <dvbFrontend>`
    };
    const pinned = { ...automatic, name: "DVB-Pinned", dvbFrontendPath: "/dev/dvb/adapter5/frontend2" };
    const legacy = { name: "Legacy", types: ["BS"], command: "legacy-receiver <channel>", isDisabled: true };
    await config.saveTuners([automatic, pinned, legacy]);
    assert.ok(fs.statSync(process.env.TUNERS_CONFIG_PATH).size < 1048576);
    shared.config = {
        server: { port: 0, hostname: "localhost", disableIPv6: true, disableWebUI: !uiMode,
            disableEITParsing: true, allowIPv4CidrRanges: ["127.0.0.0/8"], allowIPv6CidrRanges: [], allowOrigins: [] },
        channels: [{ name: "DVB test", type: "GR", channel: "27" },
            { name: "Pinned test", type: "GR", channel: "28", allowedTuners: ["DVB-Pinned"] }],
        tuners: await config.loadTuners()
    };
    shared.event = new Event();
    shared.program = { history: { flush: async () => {} }, itemMap: new Map() };
    shared.service = new Service(); shared.service.save = () => {};
    shared.job = { items: [], schedules: [], add() {}, addSchedule() {} };
    const read = fs.readdirSync, exists = fs.existsSync;
    const directoryMock = mock.method(fs, "readdirSync", (path, ...args) => path === "/dev/dvb" ? ["adapter3", "adapter5"] :
        path === "/dev/dvb/adapter3" ? ["frontend1"] : path === "/dev/dvb/adapter5" ? ["frontend2"] : read(path, ...args));
    const existsMock = mock.method(fs, "existsSync", path => /^\/dev\/dvb\/adapter[35]\/frontend[12]$/.test(path) || exists(path));
    const spawnMock = mock.method(cp, "spawnSync", () => ({ status: 0, stdout: "Supported delivery system:\n    [ISDBT]\n", stderr: "" }));
    try {
        shared.tuner = new Tuner();
    } finally {
        directoryMock.mock.restore(); existsMock.mock.restore(); spawnMock.mock.restore();
    }
    shared.channel = new Channel(); shared.channel.save = () => {};
    server.testMode = true; shared.server = server;
    await server.init();
    const base = `http://127.0.0.1:${[...server.servers][0].address().port}`;
    const readJSON = async path => {
        const response = await fetch(base + path);
        assert.equal(response.status, 200, path);
        return response.json();
    };
    assert.deepEqual(await readJSON("/api/config/tuners"), [automatic, pinned, legacy]);
    const put = data => fetch(`${base}/api/config/tuners`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const updated = [{ ...automatic, name: "DVB-Automatic" }, pinned, legacy];
    const saved = await put(updated);
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), updated);
    assert.deepEqual(await readJSON("/api/config/tuners"), updated);
    assert.deepEqual(yaml.load(fs.readFileSync(process.env.TUNERS_CONFIG_PATH, "utf8")), updated);
    const rejected = await put([{ ...automatic, command: "fixed-device-command" }, pinned, legacy]);
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), { code: 400,
        reason: "Tuner #0: DVB commands require <dvbFrontendPath> or both <dvbAdapter> and <dvbFrontend>", errors: [] });
    assert.deepEqual(await readJSON("/api/config/tuners"), updated);
    const idle = await readJSON("/api/tuners");
    assert.deepEqual(idle, [automatic, pinned].map((item, index) => ({ index, name: item.name, types: item.types,
        command: null, pid: null, users: [], isAvailable: true, isRemote: false, isFree: true, isUsing: false, isFault: false })));

    const controller = new AbortController(); requests.push(controller);
    const response = await fetch(`${base}/api/channels/GR/27/stream?decode=0&format=ts`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "video/MP2T");
    const reader = response.body.getReader();
    const received = await reader.read();
    assert.equal(received.done, false);
    assert.ok(received.value.byteLength >= 188);
    assert.equal(received.value[0], 0x47);
    const active = await readJSON("/api/tuners");
    assert.equal(active[0].isUsing, true);
    assert.match(active[0].command, / 3 1$/);
    assert.equal(active[0].users.length, 1);
    assert.equal(shared.tuner.get(1).canStartStream(shared.channel.get("GR", "27")), true);
    const pinnedController = new AbortController(); requests.push(pinnedController);
    const pinnedResponse = await fetch(`${base}/api/channels/GR/28/stream?decode=0&format=ts`, { signal: pinnedController.signal });
    assert.equal(pinnedResponse.status, 200);
    const pinnedReader = pinnedResponse.body.getReader();
    const pinnedBytes = await pinnedReader.read();
    assert.equal(pinnedBytes.done, false);
    assert.equal(pinnedBytes.value[0], 0x47);
    const concurrent = await readJSON("/api/tuners");
    assert.equal(concurrent.filter(device => device.isUsing).length, 2);
    assert.match(concurrent[0].command, / 3 1$/);
    assert.match(concurrent[1].command, / 5 2$/);
    pinnedController.abort();
    await pinnedReader.cancel().catch(() => {});
    await shared.tuner.get(1).kill();
    controller.abort();
    await reader.cancel().catch(() => {});
    await shared.tuner.get(0).kill();
    const released = await readJSON("/api/tuners");
    assert.equal(released[0].pid, null);
    assert.equal(released[0].isFree, true);
    console.log("DVB HTTP acceptance: configuration GET/PUT/readback/400 preservation, tuner GET and concurrent automatic/pinned channel streams all passed (simulated driver and source)");

    if (uiMode) {
        console.log(`DVB_UI_URL=${base}/config/tuners`);
        await new Promise(resolve => {
            const done = () => { process.off("SIGINT", done); process.off("SIGTERM", done); resolve(); };
            process.once("SIGINT", done); process.once("SIGTERM", done);
        });
    }
});
