const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PassThrough } = require("node:stream");

const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = {
    id: statusPath, filename: statusPath, loaded: true,
    exports: { __esModule: true, default: { streamCount: { tsFilter: 0 }, epg: {} } }
};

const _ = require("../lib/Mirakurun/_").default;
const ChannelItem = require("../lib/Mirakurun/ChannelItem").default;
const Tuner = require("../lib/Mirakurun/Tuner").default;
const { TunerStartupError } = require("../lib/Mirakurun/TunerDevice");

function channel(name, allowedTuners) {
    return new ChannelItem({ name, type: "BS4K", channel: "BS15_0", route: name, allowedTuners });
}

function packet() {
    const value = Buffer.alloc(188, 0xff);
    value[0] = 0x47;
    value[1] = 0x00;
    value[2] = 0x14;
    value[3] = 0x10;
    return value;
}

function device(index, name, startStream) {
    return {
        index,
        isRemote: false,
        isAvailable: true,
        isFree: true,
        isUsing: false,
        channel: null,
        users: [],
        decoder: null,
        mmtsDecoder: null,
        config: { name, types: ["BS4K"] },
        canReuseStream() { return false; },
        canStartStream() { return true; },
        getPriority() { return 0; },
        startStream
    };
}

function tuner(devices) {
    _.config = { server: { disableEITParsing: true } };
    _.channel = { save() {}, invalidateStreamIDIndex() {} };
    const value = Object.create(Tuner.prototype);
    value._devices = devices;
    value._readyForJobPickedDeviceSet = new Set();
    value._handoffFailureUntil = new Map();
    value._channelFailureUntil = new Map();
    value._sourceFailureState = new Map();
    return value;
}

function user() {
    return { id: "routing-test", priority: 0 };
}

test("initServiceStream skips an unavailable route and starts the next allowed local route", async () => {
    const unavailable = channel("CATV", ["missing-tuner"]);
    const local = channel("SAT", ["local-tuner"]);
    const started = [];
    const value = tuner([device(0, "local-tuner", async (_user, stream, selected) => {
        started.push(selected);
        stream.write(packet());
    })]);
    const service = { channel: unavailable, channels: [unavailable, local], serviceId: 101, networkId: 11 };

    const filter = await value.initServiceStream(service, user(), new PassThrough());
    assert.ok(filter);
    assert.deepEqual(started, [local]);
    filter.close();
});

test("initServiceStream preferredChannel pins the selected channel-service route", async () => {
    const catv = channel("CATV", ["catv-tuner"]);
    const sat = channel("SAT", ["sat-tuner"]);
    const started = [];
    const value = tuner([
        device(0, "catv-tuner", async (_user, stream, selected) => { started.push(selected); stream.write(packet()); }),
        device(1, "sat-tuner", async (_user, stream, selected) => { started.push(selected); stream.write(packet()); })
    ]);
    const service = { channel: catv, channels: [catv, sat], serviceId: 101, networkId: 11 };

    const filter = await value.initServiceStream(service, user(), new PassThrough(), sat);
    assert.ok(filter);
    assert.deepEqual(started, [sat]);
    filter.close();
});

test("initStreamIDStream holds synchronous source bytes until startup resolves", async () => {
    const selected = channel("SAT", ["local-tuner"]);
    selected.setStream(0, 500, 11, false);
    let resolveStartup;
    const source = Buffer.concat(Array.from({ length: 106 }, () => packet()));
    const value = tuner([device(0, "local-tuner", (_user, stream) => {
        stream.write(source);
        return new Promise(resolve => { resolveStartup = resolve; });
    })]);
    _.channel.getStreamID = (networkId, streamId) => networkId === 11 && streamId === 500
        ? { networkId, streamId, streamFormat: "ts", channels: [{ channel: selected }] }
        : undefined;
    const output = new PassThrough();
    const chunks = [];
    output.on("data", chunk => chunks.push(Buffer.from(chunk)));
    const originalPipe = PassThrough.prototype.pipe;
    let outputPipeCount = 0;
    PassThrough.prototype.pipe = function (destination, ...args) {
        if (destination === output) {
            ++outputPipeCount;
        }
        return originalPipe.call(this, destination, ...args);
    };

    try {
        const starting = value.initStreamIDStream(11, 500, user(), output);
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(chunks, []);
        assert.equal(outputPipeCount, 0);
        resolveStartup();
        const filter = await starting;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(outputPipeCount, 1);
        assert.deepEqual(Buffer.concat(chunks), source);
        filter.close();
    } finally {
        PassThrough.prototype.pipe = originalPipe;
    }
});

test("failed startup closes only its gate and retries the next route", async () => {
    const failed = channel("CATV", ["failed-tuner"]);
    const healthy = channel("SAT", ["healthy-tuner"]);
    const started = [];
    const value = tuner([
        device(0, "failed-tuner", async (_user, _stream, selected) => {
            started.push(selected);
            throw new TunerStartupError("route unavailable", "channel");
        }),
        device(1, "healthy-tuner", async (_user, stream, selected) => {
            started.push(selected);
            stream.write(packet());
        })
    ]);
    const output = new PassThrough();
    const service = { channel: failed, channels: [failed, healthy], serviceId: 101, networkId: 11 };

    const filter = await value.initServiceStream(service, user(), output);
    assert.deepEqual(started, [failed, healthy]);
    assert.equal(output.destroyed, false);
    filter.close();
});
