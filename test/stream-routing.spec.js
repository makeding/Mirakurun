const assert = require("node:assert/strict");
const { test } = require("node:test");

const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = {
    id: statusPath,
    filename: statusPath,
    loaded: true,
    exports: { __esModule: true, default: { streamCount: { tsFilter: 0 }, epg: {} } }
};

const _ = require("../lib/Mirakurun/_").default;
const db = require("../lib/Mirakurun/db");
const Event = require("../lib/Mirakurun/Event").default;
const { Channel } = require("../lib/Mirakurun/Channel");
const Service = require("../lib/Mirakurun/Service").default;
const ServiceItem = require("../lib/Mirakurun/ServiceItem").default;
const { Server } = require("../lib/Mirakurun/Server");

function setup(channels) {
    _.config = {
        server: {
            port: 0,
            hostname: "localhost",
            disableIPv6: true,
            disableWebUI: true,
            disableEITParsing: true,
            allowIPv4CidrRanges: ["127.0.0.0/8"],
            allowIPv6CidrRanges: [],
            allowOrigins: []
        },
        channels,
        tuners: []
    };
    _.configIntegrity = { channels: "stream-routing" };
    _.event = new Event();
    _.job = { add() {}, addSchedule() {} };
    _.program = { history: { flush: async () => {} } };
    _.tuner = { hasLocalTunerForChannel() { return true; }, typeExists() { return true; } };
    _.channel = new Channel();
    _.service = new Service();
    _.service.save = () => {};
}

function configs() {
    return [
        { name: "CATV A", type: "BS4K", channel: "BS15_0", route: "CATV", allowedTuners: ["catv-a"] },
        { name: "SAT B", type: "BS4K", channel: "BS15_0", route: "SAT", allowedTuners: ["sat-b"] }
    ];
}

test("legacy service records keep their original channel without inventing a stream ID", async t => {
    setup(configs());
    const originalLoadServices = db.loadServices;
    const originalSetTimeout = global.setTimeout;
    db.loadServices = async () => [{
        id: 1100101,
        networkId: 11,
        serviceId: 101,
        name: "legacy service",
        type: 1,
        channel: { type: "BS4K", channel: "BS15_0", route: "CATV" }
    }];
    global.setTimeout = (fn, delay, ...args) => {
        if (delay === 10000) { return { unref() {} }; }
        const timer = originalSetTimeout(fn, delay, ...args);
        return timer;
    };
    t.after(() => { db.loadServices = originalLoadServices; global.setTimeout = originalSetTimeout; });

    await _.service.load();
    const service = _.service.get(11, 101);
    const legacy = _.channel.get("BS4K", "BS15_0", "CATV");

    assert.equal(service.channel, legacy);
    assert.deepEqual(service.channels, [legacy]);
    assert.equal(service.streamId, undefined);
    assert.equal(JSON.parse(JSON.stringify(service.export())).streamId, undefined);
    assert.deepEqual(_.channel.getStreamIDs(), []);
});

test("observed routes preserve tuner restrictions and are returned by channel, service, and StreamID HTTP APIs", async t => {
    setup(configs());
    const catv = _.channel.get("BS4K", "BS15_0", "CATV");
    const sat = _.channel.get("BS4K", "BS15_0", "SAT");
    assert.deepEqual(catv.allowedTuners, ["catv-a"]);
    assert.deepEqual(sat.allowedTuners, ["sat-b"]);

    for (const channel of [catv, sat]) {
        channel.setStream(0, 500, 11, true);
        channel.addServiceId(101, 0);
    }
    _.service.add(new ServiceItem(catv, 11, 101, "route service", 1, -1, -1, false, 0, 500));

    const server = new Server();
    server.testMode = true;
    _.server = server;
    t.after(async () => {
        for (const listener of server.servers) { listener.closeAllConnections(); }
        await server.deinit();
    });
    await server.init();
    const base = `http://127.0.0.1:${[...server.servers][0].address().port}/api`;
    const json = async (path, expected = 200) => {
        const response = await fetch(base + path);
        const body = await response.text();
        assert.equal(response.status, expected, `${path}: ${body}`);
        return body ? JSON.parse(body) : undefined;
    };

    const channels = await json("/channels");
    assert.deepEqual(channels.map(value => value.route).sort(), ["CATV", "SAT"]);
    assert.ok(channels.every(value => value.services[0].streamId === 500));

    const services = await json("/services?networkId=11&serviceId=101");
    assert.equal(services.length, 1);
    assert.equal(services[0].streamId, 500);
    assert.deepEqual(services[0].channel, { type: "BS4K", channel: "BS15_0" });
    assert.deepEqual(services[0].channels.map(value => value.route).sort(), ["CATV", "SAT"]);

    const expectedStream = {
        networkId: 11,
        streamId: 500,
        streamFormat: "tlv",
        channels: [
            { type: "BS4K", channel: "BS15_0", route: "CATV" },
            { type: "BS4K", channel: "BS15_0", route: "SAT" }
        ]
    };
    assert.deepEqual(await json("/streamids"), [expectedStream]);
    assert.deepEqual(await json("/streamids/11"), [expectedStream]);
    assert.deepEqual(await json("/streamids/11/500"), expectedStream);
    await json("/streamids/11/501", 404);
});
