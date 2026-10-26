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
const cp = require("node:child_process");
const { once } = require("node:events");
const { PassThrough } = require("node:stream");
const {
    parseDvbDeliverySystems, discoverDvbFrontends, generateDvbTunerConfigs, validateDvbConfig, supportsDvbChannel, DvbFrontendPool
} = require("../lib/Mirakurun/DvbFrontend");

const gr = { type: "GR", route: "TER" };
const bs = { type: "BS", route: "SAT" };
const frontend = (adapter, systems = ["ISDBT"], number = 0) => ({
    path: `/dev/dvb/adapter${adapter}/frontend${number}`, adapter, frontend: number, systems
});
const entry = (overrides = {}) => ({ name: "DVB", types: ["GR", "BS"], dvbAutoDiscovery: true,
    command: "recisdb tune --device <dvbFrontendPath> -c <channel> --no-decode -", ...overrides });
const pool = (frontends, configs, exists = () => true) => new DvbFrontendPool(frontends, configs, exists);

test("DVB advertised systems exclude misleading names and the current system", () => {
    const text = "Device ISDBS3 DVB-S2\nDVB API Version 5.11, Current v5 delivery system: ISDBS3\n" +
        "Supported delivery systems:\n    [ISDBT]\n    ISDBS\nFrequency range: 0\nISDBS3\n";
    assert.deepEqual(parseDvbDeliverySystems(text), ["ISDBT", "ISDBS"]);
    assert.deepEqual(parseDvbDeliverySystems("Supported delivery system: \n    [ISDBT]\n"), ["ISDBT"]);
    assert.deepEqual(parseDvbDeliverySystems("Device ISDBT\nCurrent v5 delivery system: ISDBT"), []);
});

test("DVB discovery enumerates all frontend numbers in numeric order and isolates errors", () => {
    const calls = [];
    const found = discoverDvbFrontends(path => path === "/dev/dvb" ? ["adapter10", "adapter2", "unrelated"] :
        path.endsWith("adapter2") ? ["frontend2", "frontend0", "dvr0"] : ["frontend0"], (adapter, number) => {
        calls.push([adapter, number]);
        if (number === 2) { throw new Error("permission denied"); }
        return "Supported delivery system:\n    [ISDBT]\n";
    });
    assert.deepEqual(calls, [[2, 0], [2, 2], [10, 0]]);
    assert.deepEqual(found.map(item => item.path), ["/dev/dvb/adapter2/frontend0", "/dev/dvb/adapter10/frontend0"]);
    assert.deepEqual(discoverDvbFrontends(() => { throw new Error("ENOENT"); }), []);
});

test("DVB probe is bounded, read-only, locale-stable and rejects unsuccessful output", t => {
    let response = { status: 0, stdout: "", stderr: "Supported delivery systems:\n    [ISDBT]\n" };
    const spawn = mock.method(cp, "spawnSync", (command, args, options) => {
        assert.equal(command, "dvb-fe-tool");
        assert.deepEqual(args, ["-a", "3", "-f", "2"]);
        assert.equal(options.env.LC_ALL, "C");
        assert.equal(options.timeout, 2000);
        assert.equal(options.maxBuffer, 65536);
        return response;
    });
    t.after(() => spawn.mock.restore());
    const read = path => path === "/dev/dvb" ? ["adapter3"] : ["frontend2"];
    assert.equal(discoverDvbFrontends(read).length, 1);
    response = { ...response, status: 1 };
    assert.equal(discoverDvbFrontends(read).length, 0);
    response = { status: null, error: new Error("spawn dvb-fe-tool ENOENT") };
    assert.equal(discoverDvbFrontends(read).length, 0);
});

test("DVB matching uses actual delivery systems and physical routes", () => {
    assert.equal(supportsDvbChannel(frontend(0), gr), true);
    assert.equal(supportsDvbChannel(frontend(0), bs), false);
    assert.equal(supportsDvbChannel(frontend(0, ["ISDBS"]), bs), true);
    assert.equal(supportsDvbChannel(frontend(0, ["ISDBS", "DVBS2"]), { type: "BS4K", route: "SAT" }), false);
    assert.equal(supportsDvbChannel(frontend(0, ["ISDBS3"]), { type: "BS4K", route: "SAT" }), true);
    assert.equal(supportsDvbChannel(frontend(0, ["ISDBC"]), { type: "BS", route: "CATV" }), true);
    assert.equal(supportsDvbChannel(frontend(0, ["ISDBS"]), { type: "BS", route: "HIKARI" }), false);
    assert.equal(supportsDvbChannel(frontend(0, ["DVBS2"]), { type: "SKY", route: "SAT" }), true);
});

test("DVB automatic entries lease compatible resources and release them", () => {
    const devices = pool([frontend(0, ["ISDBS"]), frontend(1), frontend(2, ["ISDBT", "ISDBS"])], [entry(), entry(), entry()]);
    assert.equal(devices.acquire(0, gr).adapter, 1);
    assert.equal(devices.acquire(1, bs).adapter, 0);
    assert.equal(devices.acquire(2, gr).adapter, 2);
    assert.equal(devices.canAcquire(0, bs), false);
    devices.release(1);
    devices.release(0);
    assert.equal(devices.acquire(0, bs).adapter, 0);
});

test("DVB frontend modes sharing an adapter cannot be double allocated", () => {
    const devices = pool([frontend(0), frontend(0, ["ISDBS"], 1)], [entry(), entry()]);
    devices.acquire(0, gr);
    assert.equal(devices.canAcquire(1, bs), false);
    assert.throws(() => devices.acquire(1, gr), /No free compatible/);
    devices.release(0);
    assert.equal(devices.acquire(1, bs).frontend, 1);
});

test("DVB pins reserve idle adapters and never fall back to another frontend", () => {
    const devices = pool([frontend(0), frontend(1)], [entry(), entry({ dvbFrontendPath: frontend(0).path })]);
    assert.equal(devices.acquire(0, gr).adapter, 1);
    assert.equal(devices.acquire(1, gr).adapter, 0);
    const absent = pool([frontend(1)], [entry({ dvbFrontendPath: frontend(0).path })]);
    assert.equal(absent.canAcquire(0, gr), false);
    const conflict = pool([frontend(0)], [entry({ dvbFrontendPath: frontend(0).path }), entry({ dvbFrontendPath: frontend(0).path })]);
    assert.equal(conflict.canAcquire(0, gr), false);
    assert.equal(conflict.canAcquire(1, gr), false);
});

test("DVB legacy explicit paths and zap adapter flags reserve resources", () => {
    for (const legacy of [
        { dvbDevicePath: "/dev/dvb/adapter0/dvr0" },
        { checkDevicePath: "/dev/dvb/adapter0/frontend0" },
        { command: "recisdb tune --device /dev/dvb/adapter0/frontend0 -" },
        { command: "dvbv5-zap -a 0 -r channel" },
        { command: "dvbv5-zap --adapter=0 -r channel" },
        { command: "dvbv5-zap -r channel" }
    ]) {
        const devices = pool([frontend(0), frontend(1)], [entry(), { name: "legacy", types: ["GR"], ...legacy }]);
        assert.equal(devices.acquire(0, gr).adapter, 1, JSON.stringify(legacy));
    }
    const disabled = pool([frontend(0)], [entry(), entry({ isDisabled: true, dvbFrontendPath: frontend(0).path })]);
    assert.equal(disabled.acquire(0, gr).adapter, 0);
});

test("DVB removed devices are not selectable", () => {
    let present = true;
    const devices = pool([frontend(0)], [entry()], () => present);
    assert.equal(devices.canAcquire(0, gr), true);
    present = false;
    assert.equal(devices.canAcquire(0, gr), false);
});

test("DVB validation keeps legacy commands and rejects ambiguous device routing", () => {
    assert.equal(validateDvbConfig({ command: "recpt1 --device /dev/pt3video0 27 - -" }), null);
    assert.equal(validateDvbConfig(entry()), null);
    assert.match(validateDvbConfig(entry({ command: undefined })), /requires a tuning command/);
    assert.equal(validateDvbConfig(entry({ command: "dvbv5-zap -a <dvbAdapter> -f <dvbFrontend> <channel>" })), null);
    assert.match(validateDvbConfig(entry({ command: "dvbv5-zap -a 0 <channel>" })), /commands require/);
    assert.match(validateDvbConfig(entry({ commandBS4K: "fixed" })), /commands require/);
    assert.match(validateDvbConfig(entry({ remoteMirakurunHost: "remote" })), /local tuner/);
    assert.match(validateDvbConfig(entry({ dvbFrontendPath: "/dev/dvb/adapter0/dvr0" })), /frontendM/);
    assert.match(validateDvbConfig(entry({ dvbDevicePath: "/dev/dvb/adapter0/dvr0" })), /pinned frontend/);
    assert.match(validateDvbConfig(entry({ dvbFrontendPath: frontend(0).path, dvbDevicePath: "/dev/dvb/adapter1/dvr0" })), /same adapter/);
    assert.equal(validateDvbConfig(entry({ dvbFrontendPath: frontend(0).path, dvbDevicePath: "/dev/dvb/adapter0/dvr0" })), null);
});

const shared = require("../lib/Mirakurun/_").default;
const Event = require("../lib/Mirakurun/Event").default;
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true,
    exports: { __esModule: true, default: { errorCount: { tunerDeviceRespawn: 0 } } } };
const TunerDevice = require("../lib/Mirakurun/TunerDevice").default;
const ChannelItem = require("../lib/Mirakurun/ChannelItem").default;
const channel = () => new ChannelItem({ name: "test", type: "GR", channel: "27",
    commandVars: { dvbAdapter: 99, dvbFrontend: 99, dvbFrontendPath: "wrong" } });
const sink = () => { const stream = new PassThrough(); stream.closed = false; return stream; };

test("DVB tuner command receives the leased slot, blocks competitors and releases after kill", { timeout: 5000 }, async t => {
    shared.event = new Event();
    const config = entry({ command: `${process.execPath} -e "process.stdout.write(process.argv.slice(1).join(','));setInterval(()=>{},1000)" <dvbAdapter> <dvbFrontend> <dvbFrontendPath>` });
    const devices = pool([frontend(4, ["ISDBT"], 2)], [config, entry()]);
    const device = new TunerDevice(0, config, devices);
    t.after(async () => { if (device.pid) { await device.kill(); } });
    const output = sink();
    const data = once(output, "data");
    const ch = channel();
    await device.startStream({ id: "test", priority: 0 }, output, ch);
    assert.equal(String((await data)[0]), "4,2,/dev/dvb/adapter4/frontend2");
    assert.equal(devices.canAcquire(1, gr), false);
    assert.equal(device.canReuseStream(ch, false), true);
    await device.kill();
    assert.equal(devices.acquire(1, gr).adapter, 4);
});

test("DVB spawn error releases the lease and permits another configured slot", { timeout: 5000 }, async () => {
    shared.event = new Event();
    const config = entry({ command: "/nonexistent-mirakurun-dvb-command <dvbFrontendPath>" });
    const devices = pool([frontend(0)], [config, entry()]);
    const device = new TunerDevice(0, config, devices);
    let releases = 0;
    device.on("release", () => releases++);
    const released = once(device, "release");
    await device.startStream({ id: "missing", priority: 0 }, sink(), channel());
    await released;
    assert.equal(device.pid, null);
    assert.equal(devices.canAcquire(1, gr), true);
    // Node emits both error and close for ENOENT. A second deferred release
    // must not destroy a newly acquired lease after the first release.
    devices.acquire(1, gr);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(releases, 1);
    assert.equal(devices.canAcquire(0, gr), false);
});

test("DVB disabled selection preserves legacy stdout commands", { timeout: 5000 }, async t => {
    shared.event = new Event();
    const config = { name: "stdout", types: ["GR"], command: `${process.execPath} -e "process.stdout.write('legacy');setInterval(()=>{},1000)"` };
    const device = new TunerDevice(0, config);
    t.after(async () => { if (device.pid) { await device.kill(); } });
    const output = sink();
    const data = once(output, "data");
    await device.startStream({ id: "legacy", priority: 0 }, output, channel());
    assert.equal(String((await data)[0]), "legacy");
    await device.kill();
});

test("DVB prefers dedicated frontends and permits a hybrid mode change after release", () => {
    const devices = pool([frontend(0, ["ISDBT", "ISDBS"]), frontend(1)], [entry(), entry()]);
    assert.equal(devices.acquire(0, gr).adapter, 1);
    assert.equal(devices.acquire(1, bs).adapter, 0);
    const hybrid = pool([frontend(0), frontend(0, ["ISDBS"], 1)], [entry()]);
    hybrid.acquire(0, gr);
    assert.equal(hybrid.canAcquire(0, bs), true);
    assert.throws(() => hybrid.acquire(0, bs), /must release/);
    hybrid.release(0);
    assert.equal(hybrid.acquire(0, bs).frontend, 1);
});


test("DVB initial configuration generation counts adapters and recognizes all frontend numbers", () => {
    const generated = generateDvbTunerConfigs([frontend(3), frontend(3, ["ISDBS"], 2), frontend(8, ["ISDBS"]), frontend(10, ["DVBT2"])]);
    assert.deepEqual(generated.map(item => [item.name, item.types]), [
        ["adapter3", ["GR"]], ["adapter8", ["BS", "CS"]]
    ]);
    for (const item of generated) {
        assert.equal(item.dvbAutoDiscovery, true);
        assert.equal(item.dvbFrontendPath, undefined);
        assert.equal(item.dvbDevicePath, undefined);
        assert.equal(validateDvbConfig(item), null);
    }
});


test("DVB device disappearance at normal child exit closes users and frees its lease", { timeout: 5000 }, async () => {
    shared.event = new Event();
    let present = true;
    const config = entry({ command: `${process.execPath} -e "setTimeout(()=>process.exit(0),60)" <dvbFrontendPath>` });
    const devices = pool([frontend(0)], [config, entry()], () => present);
    const device = new TunerDevice(0, config, devices);
    const output = sink();
    const released = once(device, "release");
    await device.startStream({ id: "unplug", priority: 0 }, output, channel());
    present = false;
    await released;
    assert.equal(device.pid, null);
    assert.equal(device.users.length, 0);
    assert.equal(output.writableEnded, true);
    present = true;
    assert.equal(devices.canAcquire(1, gr), true);
});
