const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PassThrough } = require("node:stream");
const { EventEmitter } = require("node:events");

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
    return Object.assign(new EventEmitter(), {
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
    });
}

function tuner(devices) {
    _.config = { server: { disableEITParsing: true } };
    _.service = { findByChannel: () => [] };
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

test("one failed satellite slot skips its whole reception group on this request and the next channel", async () => {
    const firstChannel = channel("SAT");
    const otherChannel = new ChannelItem({ name: "CS", type: "CS", channel: "CS2" });
    const started = [];
    const failing = device(0, "roof-1", async () => {
        started.push("roof-1");
        throw new TunerStartupError("no signal", "channel");
    });
    const sibling = device(1, "roof-2", async () => { started.push("roof-2"); });
    const backup = device(2, "backup", async (_user, stream) => { started.push("backup"); stream.write(packet()); });
    for (const receiver of [failing, sibling, backup]) { receiver.config.types = ["BS4K", "CS"]; }
    backup.config.group = "other-site";
    const value = tuner([failing, sibling, backup]);
    const first = await value.initChannelStream(firstChannel, user(), new PassThrough());
    const next = await value.initChannelStream(otherChannel, user(), new PassThrough());
    assert.deepEqual(started, ["roof-1", "backup", "backup"]);
    first.close(); next.close();
});

test("foreground uses the only eligible tuner despite reception and device cooldowns", async () => {
    const selected = channel("SAT");
    let starts = 0;
    let options;
    const receiver = device(0, "only", async (_user, stream, _channel, _recover, startOptions) => {
        ++starts; options = startOptions; stream.write(packet());
    });
    receiver.canStartStream = (_channel, _recover, ignoreCooldown) => ignoreCooldown === true;
    const value = tuner([receiver]);
    value._markSourceFailure(receiver, value._getGroupKey(receiver, selected));
    value._markChannelFailure(receiver, selected);
    const filter = await value.initChannelStream(selected, user(), new PassThrough());
    assert.equal(starts, 1);
    assert.equal(options.ignoreFailureCooldown, true);
    filter.close();receiver.emit("release");
});

test("foreground retries a sibling when a failed group is the only reception path", async () => {
    const selected = channel("SAT");
    const started = [];
    const first = device(0, "first", async () => {
        started.push("first");throw new TunerStartupError("no data", "channel");
    });
    const second = device(1, "second", async (_user, stream) => {
        started.push("second");stream.write(packet());
    });
    const value = tuner([first, second]);
    const filter = await value.initChannelStream(selected, user(), new PassThrough());
    assert.deepEqual(started, ["first", "second"]);
    filter.close();second.emit("release");
});

test("one acquisition cannot loop on a failing last tuner", async () => {
    const selected = channel("SAT");
    let starts = 0;
    const value = tuner([device(0, "only", async () => {
        ++starts;throw new TunerStartupError("no data", "channel");
    })]);
    await assert.rejects(value.initChannelStream(selected, user(), new PassThrough()), /startup attempts failed/);
    assert.equal(starts, 1);
});

test("tuner release retires its recovery probe before the observation window ends", () => {
    const selected = channel("SAT");
    const receiver = device(0, "only", async () => {});
    const value = tuner([receiver]);
    const key = value._getGroupKey(receiver, selected);
    value._markSourceFailure(receiver, key);
    value._sourceFailureState.get(key).retryAt = 0;
    assert.equal(value._beginSourceProbe(receiver, selected), true);
    value._validateSourceRecovery(receiver, selected);
    assert.equal(value._isSourceFailureCoolingDown(receiver, selected), true);
    assert.equal(receiver.listenerCount("release"), 1);
    receiver.emit("release");
    const state = value._sourceFailureState.get(key);
    assert.equal(state.probing, false);
    assert.equal(state.timer, undefined);
    assert.equal(receiver.listenerCount("release"), 0);
    assert.equal(value._isSourceFailureCoolingDown(receiver, selected), false);
});

test("scarcity does not bypass a frontend lease or preempt an equal-priority viewer", () => {
    const selected = channel("SAT");
    const leased = device(0, "leased", async () => {});
    leased.canStartStream = () => false;
    const occupied = device(1, "occupied", async () => {});
    occupied.isFree = false;occupied.isUsing = true;occupied.users = [{ priority: 0 }];
    occupied.channel = channel("CATV");
    const value = tuner([leased, occupied]);
    assert.equal(value._pickTunerDevice([leased, occupied], selected, 0,
        false, true, false, undefined, true), null);
});
