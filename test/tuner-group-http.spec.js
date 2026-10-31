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
const { test } = require("node:test");
const assert = require("node:assert/strict");

const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true,
    exports: { __esModule: true, default: { rpcCount: 0, epg: {},
        streamCount: { tsFilter: 0 }, errorCount: { tunerDeviceRespawn: 0 } } } };
const _ = require("../lib/Mirakurun/_").default;
const Event = require("../lib/Mirakurun/Event").default;
const { Channel } = require("../lib/Mirakurun/Channel");
const Service = require("../lib/Mirakurun/Service").default;
const Tuner = require("../lib/Mirakurun/Tuner").default;
const { Server } = require("../lib/Mirakurun/Server");

test("channel HTTP tries every source and isolates failures between acquisition sessions", { timeout: 20000 }, async t => {
    const source = `${process.execPath} -e "const b=Buffer.alloc(188*128,255);for(let i=0;i<b.length;i+=188){b[i]=71;b[i+1]=0;b[i+2]=20;b[i+3]=16}setInterval(()=>process.stdout.write(b),20)"`;
    const failOnBS = `${process.execPath} -e "if(process.argv[1]==='BS15_0'){process.exit(1)};${source.split(' -e "')[1]} <channel>`;
    _.config = {
        server: { port: 0, hostname: "localhost", disableIPv6: true, disableWebUI: true,
            disableEITParsing: true, allowIPv4CidrRanges: ["127.0.0.0/8"], allowIPv6CidrRanges: [], allowOrigins: [] },
        channels: [{ name: "BS", type: "BS", channel: "BS15_0" }, { name: "CS", type: "CS", channel: "CS2" }],
        tuners: [
            { name: "roof-1", types: ["BS", "CS"], cooldownSeconds: 60, command: failOnBS },
            { name: "roof-2", types: ["BS", "CS"], command: source },
            { name: "other-site", group: "other-site", types: ["BS", "CS"], command: failOnBS }
        ]
    };
    _.event = new Event();
    _.job = { add() {}, addSchedule() {} };
    _.program = { history: { flush: async () => {} } };
    _.service = new Service(); _.service.save = () => {};
    _.tuner = new Tuner();
    _.channel = new Channel(); _.channel.save = () => {};
    const started = [];
    for (const device of _.tuner._devices) {
        const original = device.startStream.bind(device);
        device.startStream = (...args) => { started.push(device.config.name); return original(...args); };
    }
    const server = new Server();
    server.testMode = true; _.server = server;
    const controllers = [];
    t.after(async () => {
        for (const controller of controllers) { controller.abort(); }
        for (const device of _.tuner._devices) { if (device.pid) { await device.kill(); } }
        for (const listener of server.servers) { listener.closeAllConnections(); }
        if (server.isRunning) { await server.deinit(); }
    });
    await server.init();
    const base = `http://127.0.0.1:${[...server.servers][0].address().port}/api`;
    for (const [type, channel, selected] of [["BS", "BS15_0", 1], ["CS", "CS2", 0], ["BS", "BS15_0", 1]]) {
        const controller = new AbortController(); controllers.push(controller);
        const response = await fetch(base + `/channels/${type}/${channel}/stream?decode=0&format=ts`,
            { signal: controller.signal });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "video/MP2T");
        const reader = response.body.getReader();
        const bytes = await reader.read();
        assert.equal(bytes.done, false);
        assert.ok(bytes.value.length >= 188);
        assert.equal(bytes.value[0], 0x47);
        const status = await fetch(base + "/tuners");
        assert.equal(status.status, 200);
        const tuners = await status.json();
        assert.equal(tuners[selected].isUsing, true);
        controller.abort();
        await reader.cancel().catch(() => {});
        await _.tuner.get(selected).kill();
    }
    assert.deepEqual(started, ["roof-1", "other-site", "roof-2", "roof-1", "roof-1", "other-site", "roof-2"]);
    console.log("Session HTTP acceptance: failed groups fall back to a healthy sibling; CS and later BS requests start fresh despite a 60-second tuner cooldown");

});
