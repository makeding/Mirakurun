const assert = require("node:assert/strict");
const { test } = require("node:test");

const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = {
    id: statusPath,
    filename: statusPath,
    loaded: true,
    exports: { __esModule: true, default: { streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { decoderRespawn: 0 }, epg: {} } }
};

const _ = require("../lib/Mirakurun/_").default;
const Event = require("../lib/Mirakurun/Event").default;
const { Channel } = require("../lib/Mirakurun/Channel");
const Service = require("../lib/Mirakurun/Service").default;
const ServiceItem = require("../lib/Mirakurun/ServiceItem").default;
const StreamFilter = require("../lib/Mirakurun/StreamFilter").default;
const { Server } = require("../lib/Mirakurun/Server");

const ts = Buffer.alloc(188 * 106);
for (let i = 0; i < ts.length; i += 188) { ts[i] = 0x47; }
const tlv = Buffer.alloc(4 * 6000);
for (let i = 0; i < tlv.length; i += 4) { tlv[i] = 0x7f; tlv[i + 1] = 0xff; }

function startFilter(channel, user, output, calls, filters, sourceFormat, hold) {
    calls.push(user);
    const filter = new StreamFilter({
        output,
        channel,
        disableDecoder: user.disableDecoder,
        outputFormat: user.outputFormat
    });
    filters.push(filter);
    // Start after the operation has attached api.respondStream listeners.
    setImmediate(() => {
        filter.write(sourceFormat.value === "tlv" ? tlv : ts);
        // The production tuner owns the input lifetime.  Finish the HTTP
        // response here so this test can assert the streamed bytes before the
        // request-close cleanup tears down the injected source.
        if (!hold.value) {
            output.end();
        }
    });
    return Promise.resolve(filter);
}

test("all stream endpoints honor decode and format at the HTTP boundary", async t => {
    _.config = {
        server: {
            port: 0, hostname: "localhost", disableIPv6: true, disableWebUI: true,
            disableEITParsing: true, allowIPv4CidrRanges: ["127.0.0.0/8"],
            allowIPv6CidrRanges: [], allowOrigins: []
        },
        channels: [{ name: "4K", type: "BS4K", channel: "BS15_0" }], tuners: []
    };
    _.configIntegrity = { channels: "stream-format" };
    _.event = new Event();
    _.job = { add() {}, addSchedule() {} };
    _.program = { history: { flush: async () => {} }, get(id) { return id === 11001010001 ? { id } : null; } };
    const calls = [];
    const filters = [];
    const sourceFormat = { value: "ts" };
    const hold = { value: false };
    _.tuner = {
        hasLocalTunerForChannel() { return true; },
        typeExists() { return true; },
        initChannelStream(ch, user, output) { return startFilter(ch, user, output, calls, filters, sourceFormat, hold); },
        initServiceStream(item, user, output) { return startFilter(item.channel, user, output, calls, filters, sourceFormat, hold); },
        initProgramStream(program, user, output) { return startFilter(channel, user, output, calls, filters, sourceFormat, hold); },
        initStreamIDStream(networkId, streamId, user, output) { return startFilter(channel, user, output, calls, filters, sourceFormat, hold); }
    };
    _.channel = new Channel();
    _.channel.save = () => {};
    _.service = new Service();
    _.service.save = () => {};

    const channel = _.channel.get("BS4K", "BS15_0");
    channel.setStream(0, 500, 11, false);
    channel.addServiceId(101, 0);
    const service = new ServiceItem(channel, 11, 101, "service", 1, -1, -1, false, 0, 500);
    _.service.add(service);

    const server = new Server();
    server.testMode = true;
    _.server = server;
    t.after(async () => {
        for (const listener of server.servers) { listener.closeAllConnections(); }
        await server.deinit();
    });
    await server.init();
    const base = `http://127.0.0.1:${[...server.servers][0].address().port}/api`;
    const get = async path => {
        const response = await fetch(base + path);
        return { response, body: Buffer.from(await response.arrayBuffer()) };
    };

    const paths = [
        "/channels/BS4K/BS15_0/stream",
        "/channels/BS4K/BS15_0/services/101/stream",
        "/services/1100101/stream",
        "/programs/11001010001/stream",
        "/streamids/11/500/stream"
    ];
    for (const path of paths) {
        const { response, body } = await get(`${path}?decode=0&format=ts`);
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.get("content-type"), "video/MP2T");
        assert.deepEqual(body, ts, path);
    }
    assert.equal(calls.length, paths.length);
    assert.ok(calls.every(call => call.disableDecoder === true && call.disableMMTSDecoder === true));

    const rawTlv = await get("/channels/BS4K/BS15_0/stream?decode=0&format=tlv");
    assert.equal(rawTlv.response.status, 406);
    // The channel above advertises TS: explicit TLV must never silently return TS.
    assert.equal(rawTlv.response.headers.get("content-type"), "application/json");

    // A TLV source uses the same StreamFilter and reports the actual raw container.
    channel.setStreamFormat(0, true);
    sourceFormat.value = "tlv";
    const tlvResponse = await get("/channels/BS4K/BS15_0/stream?decode=0&format=tlv");
    assert.equal(tlvResponse.response.status, 200);
    assert.equal(tlvResponse.response.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(tlvResponse.body, tlv);

    sourceFormat.value = "ts";
    const decoded = await get("/services/1100101/stream?decode=1&format=ts");
    assert.equal(decoded.response.status, 200);
    assert.equal(calls.at(-1).disableDecoder, false);
    assert.equal(calls.at(-1).disableMMTSDecoder, false);

    hold.value = true;
    const controller = new AbortController();
    const aborted = await fetch(`${base}/channels/BS4K/BS15_0/stream?decode=0&format=ts`, { signal: controller.signal });
    assert.equal(aborted.status, 200);
    const closed = new Promise(resolve => filters.at(-1).once("close", resolve));
    controller.abort();
    await closed;
    assert.equal(filters.at(-1).closed, true);
});
