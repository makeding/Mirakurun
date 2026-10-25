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
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { once } = require("node:events");
const statusPath = require.resolve("../lib/Mirakurun/status");
const status = { streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { decoderRespawn: 0 }, epg: {} };
require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true,
    exports: { __esModule: true, default: status } };
const _ = require("../lib/Mirakurun/_").default;
const Event = require("../lib/Mirakurun/Event").default;
const { Channel } = require("../lib/Mirakurun/Channel");
const Service = require("../lib/Mirakurun/Service").default;
const ServiceItem = require("../lib/Mirakurun/ServiceItem").default;
const StreamFilter = require("../lib/Mirakurun/StreamFilter").default;
const { Server } = require("../lib/Mirakurun/Server");

test("TLV stage failures reach every HTTP stream consumer without a successful truncated body", { timeout: 15000 }, async t => {
    _.config = { server: { port: 0, hostname: "localhost", disableIPv6: true, disableWebUI: true,
        disableEITParsing: true, allowIPv4CidrRanges: ["127.0.0.0/8"], allowIPv6CidrRanges: [], allowOrigins: [] },
        channels: [{ name: "4K probe", type: "BS4K", channel: "BS15_0" }], tuners: [] };
    _.configIntegrity = { channels: "tlv-decoder-http" };
    _.event = new Event();
    _.job = { add() {}, addSchedule() {} };
    _.program = { history: { flush: async () => {} }, get: id => id === 11001010001 ? { id } : null };
    const bytes = Buffer.alloc(24000);
    for (let i = 0; i < bytes.length; i += 4) { bytes[i] = 0x7f; bytes[i + 1] = 0xff; }
    const filters = new Set(), children = [], timers = new Set();
    let mode = "normal", failedStage = "converter";
    const command = script => `${process.execPath} -e "${script}"`;
    const echo = command("process.stdin.pipe(process.stdout)");
    function start(channel, user, output) {
        const failing = command(mode === "empty" ? "process.exit(1)" : mode === "early-zero" ? "process.exit(0)" :
            mode === "eof-failure" ? "process.stdin.resume();process.stdin.on('end',()=>process.exit(1))" :
            "process.stdin.once('data',b=>process.stdout.write(b.subarray(0,188),()=>process.exit(1)))");
        const filter = new StreamFilter({ output, channel, outputFormat: user.outputFormat,
            disableDecoder: user.disableDecoder,
            tlvDecoder: mode !== "normal" && failedStage === "decryptor" ? failing : echo,
            tlvToTsDecoder: mode !== "normal" && failedStage === "converter" ? failing : echo });
        filters.add(filter);
        let count = 0;
        const timer = setInterval(() => {
            filter.write(bytes);
            if (count++ === 0) {
                let stage = filter._innerFilter._output;
                while (stage?._process) {
                    const child = stage._process;
                    children.push({ child, exited: once(child, "close") });
                    stage = stage._output;
                }
            }
            if (count === 5) { clearInterval(timer); timers.delete(timer); filter.end(); }
        }, 20);
        timers.add(timer);
        filter.once("close", () => { clearInterval(timer); timers.delete(timer); filters.delete(filter); });
        return Promise.resolve(filter);
    }
    _.tuner = { hasLocalTunerForChannel: () => true, typeExists: () => true,
        initChannelStream: start, initServiceStream: (service, user, output) => start(service.channel, user, output),
        initProgramStream: (program, user, output) => start(channel, user, output),
        initStreamIDStream: (nid, tsid, user, output) => start(channel, user, output) };
    _.channel = new Channel(); _.channel.save = () => {};
    _.service = new Service(); _.service.save = () => {};
    const channel = _.channel.get("BS4K", "BS15_0");
    channel.setStream(0, 500, 11, true); channel.addServiceId(101, 0);
    _.service.add(new ServiceItem(channel, 11, 101, "probe", 1, -1, -1, false, 0, 500));
    const server = new Server(); server.testMode = true; _.server = server;
    t.after(async () => {
        for (const timer of timers) { clearInterval(timer); }
        for (const filter of filters) { filter.close(); }
        for (const listener of server.servers) { listener.closeAllConnections(); }
        for (const { child } of children) { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); } }
        await Promise.all(children.map(item => item.exited));
        await server.deinit();
    });
    await server.init();
    const base = `http://127.0.0.1:${[...server.servers][0].address().port}/api`;
    for (const path of ["/channels/BS4K/BS15_0/stream", "/channels/BS4K/BS15_0/services/101/stream",
        "/services/1100101/stream", "/programs/11001010001/stream", "/streamids/11/500/stream"]) {
        for (failedStage of ["decryptor", "converter"]) {
            for (mode of ["normal", "empty", "early-zero", "partial", "eof-failure"]) {
                const response = await fetch(`${base}${path}?decode=1&format=ts`, { signal: AbortSignal.timeout(3000) });
                if (mode === "normal") {
                    assert.equal(response.status, 200);
                    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.concat(Array(5).fill(bytes)));
                } else if (mode === "partial" && response.status === 200) {
                    await assert.rejects(response.arrayBuffer(), /terminated|aborted|reset/i);
                } else {
                    assert.equal(response.status, 503, `${path} ${failedStage} ${mode}`);
                    assert.deepEqual(await response.json(), { code: 503, reason: "Stream Decoder Failed", errors: [] });
                }
            }
        }
    }
    await Promise.all(children.map(item => item.exited));
    assert.equal(status.streamCount.decoder, 0);
    assert.equal(status.streamCount.tsFilter, 0);
    assert.equal(status.errorCount.decoderRespawn, 0);
});
