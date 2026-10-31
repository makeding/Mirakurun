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

test("a failed group is avoided only within the current acquisition", async () => {
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
    assert.deepEqual(started, ["roof-1", "backup", "roof-1", "backup"]);
    first.close(); next.close();
});

test("background requests retry every eligible source without inheriting another job's failure", async () => {
    const selected = channel("SAT");
    const started = [];
    const first = device(0, "first", async () => {
        started.push("first"); throw new TunerStartupError("no data", "channel");
    });
    const second = device(1, "second", async (_user, stream) => {
        started.push("second"); stream.write(packet());
    });
    const value = tuner([first, second]);
    for (let i = 0; i < 2; ++i) {
        const filter = await value.initChannelStream(selected, { ...user(), priority: -1 }, new PassThrough());
        filter.close();
    }
    assert.deepEqual(started, ["first", "second", "first", "second"]);
});

test("all failed groups still allow a healthy sibling before giving up", async () => {
    const selected = channel("SAT");
    const started = [];
    const first = device(0, "first", async () => {
        started.push("first"); throw new TunerStartupError("no data", "channel");
    });
    const sibling = device(1, "sibling", async (_user, stream) => {
        started.push("sibling"); stream.write(packet());
    });
    const backup = device(2, "backup", async () => {
        started.push("backup"); throw new TunerStartupError("offline", "source");
    });
    backup.config.group = "backup";
    const value = tuner([first, sibling, backup]);
    const filter = await value.initChannelStream(selected, user(), new PassThrough());
    assert.deepEqual(started, ["first", "backup", "sibling"]);
    filter.close();
});

test("concurrent acquisitions keep independent failure histories", async () => {
    const failingChannel = channel("SAT");
    const goodChannel = new ChannelItem({ name: "CS", type: "CS", channel: "CS22" });
    const started = [];
    let finishBackup;
    const first = device(0, "first", async (_user, stream, selected) => {
        started.push("first:" + selected.name);
        if (selected === failingChannel) { throw new TunerStartupError("no signal", "channel"); }
        stream.write(packet());
    });
    const backup = device(1, "backup", (_user, stream) => {
        started.push("backup");
        return new Promise(resolve => { finishBackup = () => { stream.write(packet()); resolve(); }; });
    });
    first.config.types.push("CS"); backup.config.types.push("CS"); backup.config.group = "backup";
    const value = tuner([first, backup]);
    const pending = value.initChannelStream(failingChannel, user(), new PassThrough());
    await new Promise(resolve => setImmediate(resolve));
    const other = await value.initChannelStream(goodChannel, user(), new PassThrough());
    assert.deepEqual(started, ["first:SAT", "backup", "first:CS"]);
    finishBackup();
    const original = await pending;
    original.close(); other.close();
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

test("scarcity does not bypass a frontend lease or preempt an equal-priority viewer", () => {
    const selected = channel("SAT");
    const leased = device(0, "leased", async () => {});
    leased.canStartStream = () => false;
    const occupied = device(1, "occupied", async () => {});
    occupied.isFree = false;occupied.isUsing = true;occupied.users = [{ priority: 0 }];
    occupied.channel = channel("CATV");
    const value = tuner([leased, occupied]);
    assert.equal(value._pickTunerDevice([leased, occupied], selected, 0,
        false, true, false, undefined), null);
});
