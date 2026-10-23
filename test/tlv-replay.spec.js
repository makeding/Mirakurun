/*
   Copyright 2026 huggy
   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy at http://www.apache.org/licenses/LICENSE-2.0
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { resolve } = require("node:path");
const { mjdBCDToUnixEpoch } = require("arib-mmt-tlv-ts/utils.js");

// Opt-in acceptance against an unchanged NHK BSP4K sample. Reads are bounded
// to 32 MiB per tuner run. SQLite stays in memory; no copies or logs are written.
test("BS4K sample -> tuner scan/EPG -> complete current/history HTTP responses", {
    skip: !process.env.BS4K_REPLAY_SAMPLE, timeout: 30000
}, async t => {
    const sample = resolve(process.env.BS4K_REPLAY_SAMPLE);
    assert.ok(fs.statSync(sample).isFile());
    const statusPath = require.resolve("../lib/Mirakurun/status");
    require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true,
        exports: { __esModule: true, default: { epg: {}, streamCount: { tsFilter: 0, decoder: 0 },
            errorCount: { tunerDeviceRespawn: 0 } } } };
    const _ = require("../lib/Mirakurun/_").default;
    const ChannelItem = require("../lib/Mirakurun/ChannelItem").default;
    const Service = require("../lib/Mirakurun/Service").default;
    const ServiceItem = require("../lib/Mirakurun/ServiceItem").default;
    const Tuner = require("../lib/Mirakurun/Tuner").default;
    const Event = require("../lib/Mirakurun/Event").default;
    const { Program } = require("../lib/Mirakurun/Program");
    const { ProgramHistory } = require("../lib/Mirakurun/ProgramHistory");
    const { Server } = require("../lib/Mirakurun/Server");
    const nativeNow = Date.now;
    // Retained sample clock, never alter its bytes or timestamps in storage.
    Date.now = () => mjdBCDToUnixEpoch(1027053016627) * 1000;
    t.after(() => { Date.now = nativeNow; });
    _.config.server = { port: 0, disableIPv6: true, disableWebUI: true,
        allowIPv4CidrRanges: ["127.0.0.0/8"], allowIPv6CidrRanges: [], allowOrigins: [] };
    _.config.tuners = [{ name: "BS4K sample", types: ["BS4K"],
        command: `head -c 33554432 "${sample}"`, mmtsDecoder: "must-not-run-for-native-metadata" }];
    _.event = new Event();
    _.job = { add() {}, addSchedule() {} };
    _.service = new Service();
    _.service.save = () => {}; // acceptance uses in-memory service ownership
    const logos = new Map();
    Service.saveLogoData = async (networkId, logoId, data) => { logos.set(`${networkId}:${logoId}`, Buffer.from(data)); };
    const channel = new ChannelItem({ name: "BS4K replay", type: "BS4K", channel: "BS15_0" });
    _.channel = { items: [channel], get: (type, number) => type === channel.type && number === channel.channel ? channel : null };
    _.tuner = new Tuner();
    const history = new ProgramHistory({ path: ":memory:", integrity: "bs4k-replay", retentionDays: 365 });
    await history.open();
    _.program = new Program({ memoryOnly: true });
    _.program._history = history;
    t.after(() => _.program.close());
    t.after(() => _.tuner.get(0).kill());

    const discovered = await _.tuner.getServices(channel);
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].networkId, 11);
    assert.equal(discovered[0].serviceId, 101);
    assert.equal(discovered[0].name, "ＮＨＫ　ＢＳＰ４Ｋ");
    assert.equal(discovered[0].remoteControlKeyId, 1);
    for (const service of discovered) {
        _.service.add(new ServiceItem(channel, service.networkId, service.serviceId, service.name,
            service.type, service.logoId, service.remoteControlKeyId));
    }
    await _.tuner.getEPG(channel, 5000);
    await history.flush();
    const expected = JSON.parse(await history.programs({ networkId: 11, serviceId: 101 }));
    assert.ok(expected.length > 0);
    const complete = expected.find(program => program.name && program.video && program.audios?.length >= 2);
    assert.ok(complete, "the real sample must supply a complete event with multiple audio components");
    assert.equal(complete.video.type, "h.265");
    assert.equal(complete.video.resolution, "2160p");
    assert.equal(complete.video.frameRate, "59.94");
    assert.equal(complete.video.transferCharacteristics, "bt2100-hlg");

    const server = new Server(); server.testMode = true; _.server = server;
    t.after(async () => { for (const listener of server.servers) listener.closeAllConnections(); await server.deinit(); });
    await server.init();
    const base = `http://127.0.0.1:${[...server.servers][0].address().port}/api`;
    const json = async route => {
        const response = await fetch(base + route);
        const text = await response.text();
        assert.equal(response.status, 200, `${route}: ${text}`);
        return JSON.parse(text);
    };
    assert.deepEqual(await json("/programs?networkId=11&serviceId=101"), expected);
    assert.deepEqual(await json(`/programs/${complete.id}`), complete);
    const services = await json("/services?networkId=11&serviceId=101");
    assert.equal(services[0].name, discovered[0].name);
    assert.equal(services[0].remoteControlKeyId, 1);
    assert.deepEqual(services[0].channel, { type: "BS4K", channel: "BS15_0" });
    const channels = await json("/channels?type=BS4K");
    assert.equal(channels[0].services[0].serviceId, 101);
    const from = complete.startAt - 1, to = complete.startAt + complete.duration + 1;
    const events = await json(`/program-history?from=${from}&to=${to}&networkId=11&serviceId=101`);
    const current = events.items.find(item => item.program.id === complete.id);
    assert.deepEqual(current.program, complete);
    const revisions = await json(`/program-history/${current.historyId}/revisions`);
    assert.ok(revisions.items.some(item => item.program.audios?.length >= 2 && item.program.video?.type === "h.265"));
    console.log(JSON.stringify({ sample, readLimitBytes: 33554432, discovered, programs: expected.length, complete, historyId: current.historyId }));
});
