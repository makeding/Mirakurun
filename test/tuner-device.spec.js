const { describe, it, beforeEach } = require("node:test");
const assert = require("assert");
const EventEmitter = require("events");

const shared = require("../lib/Mirakurun/_").default;
const MirakurunEvent = require("../lib/Mirakurun/Event").default;
const common = require("../lib/Mirakurun/common");
const ChannelItem = require("../lib/Mirakurun/ChannelItem").default;
const remoteExitCodes = require("../lib/remoteExitCodes");
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = {
    id: statusPath,
    filename: statusPath,
    loaded: true,
    exports: {
        __esModule: true,
        default: {
            errorCount: {
                tunerDeviceRespawn: 0
            }
        }
    }
};
const TunerDeviceModule = require("../lib/Mirakurun/TunerDevice");
const TunerDevice = TunerDeviceModule.default;
const TunerStartupError = TunerDeviceModule.TunerStartupError;
const Tuner = require("../lib/Mirakurun/Tuner").default;

function createTuner() {
    const tuner = Object.create(Tuner.prototype);
    tuner._sourceFailureState = new Map();
    tuner._channelFailureUntil = new Map();
    return tuner;
}

function createChannel() {
    return new ChannelItem({
        name: "Test",
        type: "GR-ALT",
        channel: "27"
    });
}

function createDevice() {
    return new TunerDevice(0, {
        name: "J-GR-1",
        types: ["GR-ALT"],
        remoteMirakurunHost: "127.0.0.1"
    });
}

function createStream() {
    const stream = new EventEmitter();
    stream.closed = false;
    stream.end = () => {
        if (stream.closed === false) {
            stream.closed = true;
            stream.emit("close");
        }
    };
    return stream;
}

function createPickDevice(options) {
    return {
        index: options.index,
        isRemote: options.isRemote,
        isAvailable: true,
        isFree: options.free === true,
        isUsing: options.using === true,
        channel: options.using === true ? options.channel : null,
        users: options.users || [],
        getPriority: () => (options.users || []).reduce((max, user) => Math.max(max, user.priority), -2),
        canReuseStream: () => options.canReuse === true,
        canStartStream: () => true,
        config: {
            name: options.name || `tuner-${options.index}`,
            types: ["GR-ALT"]
        }
    };
}

function installFakeSpawn(device) {
    device._spawn = function (channel) {
        const tunerProcess = new EventEmitter();
        tunerProcess.pid = 123;
        tunerProcess.stderr = new EventEmitter();
        tunerProcess.kill = () => undefined;

        this._process = tunerProcess;
        this._stream = new EventEmitter();
        this._channel = channel;
        this._command = "fake remote";
    };
}

describe("[tuner-device.spec] remote stream startup", () => {
    beforeEach(() => {
        shared.event = new MirakurunEvent();
    });

    it("waits for the first remote stream data", async t => {
        const device = createDevice();
        t.after(() => clearInterval(device._sourceWatchdog));
        const channel = createChannel();
        const output = createStream();
        installFakeSpawn(device);

        const starting = device.startStream({
            id: "test",
            priority: 0,
            streamSetting: { channel }
        }, output, channel);

        setImmediate(() => device._stream.emit("data", Buffer.from([0x47])));

        await starting;
        assert.strictEqual(device.users.length, 1);
    });

    it("rejects when the remote process closes before producing data", async () => {
        const device = createDevice();
        const channel = createChannel();
        const output = createStream();
        installFakeSpawn(device);

        const starting = device.startStream({
            id: "test",
            priority: 0,
            streamSetting: { channel }
        }, output, channel);

        setImmediate(() => {
            device._exited = true;
            device._process.emit("close", remoteExitCodes.REMOTE_EXIT_SOURCE_UNAVAILABLE, null);
        });

        await assert.rejects(starting, err => {
            assert.ok(err instanceof TunerStartupError);
            assert.strictEqual(err.failureScope, "source");
            return true;
        });
        assert.strictEqual(device.users.length, 0);
    });

    it("does not classify preemption before first data as a source failure", async () => {
        const device = createDevice();
        const channel = createChannel();
        const output = createStream();
        installFakeSpawn(device);
        const starting = device.startStream({ id: "Mirakurun:GGuide", priority: -1,
            streamSetting: { channel } }, output, channel);
        setImmediate(() => {
            device._closing = true;
            output.end();
            device._process.emit("close", 0, null);
        });
        await assert.rejects(starting, err => {
            assert.equal(err instanceof TunerStartupError, false);
            assert.match(err.message, /cancelled or preempted/);
            return true;
        });
        assert.equal(device.users.length, 0);
        assert.equal(output.listenerCount("close"), 0);
        assert.equal(device._process.listenerCount("close"), 0);
    });

    it("ends remote users instead of respawning the same failed tuner", () => {
        const device = createDevice();
        const channel = createChannel();
        const output = createStream();
        const tunerProcess = new EventEmitter();
        tunerProcess.stderr = new EventEmitter();

        device._process = tunerProcess;
        device._stream = new EventEmitter();
        device._channel = channel;
        device._users.add({
            id: "test",
            priority: 0,
            streamSetting: { channel },
            _stream: output
        });

        let failedChannel = null;
        device.once("streamFailure", value => failedChannel = value);
        device._release();

        assert.strictEqual(failedChannel, channel);
        assert.strictEqual(output.closed, true);
        assert.strictEqual(device.users.length, 0);
        assert.strictEqual(device.pid, null);
    });

    it("reuses a remote stream only for its exact decode and container mode", () => {
        const device = createDevice();
        const channel = createChannel();
        device._config.remoteMirakurunDecoder = true;
        device._channel = channel;
        device._remoteDecode = true;
        device._remoteOutputFormat = "tlv";

        assert.strictEqual(device.canReuseStream(channel, false, false, "tlv"), true);
        assert.strictEqual(device.canReuseStream(channel, true, true, "tlv"), false);
        assert.strictEqual(device.canReuseStream(channel, false, false, "ts"), false);
    });
});

describe("[tuner-device.spec] failed command release", () => {
    it("releases an active local source that stops sending data instead of retaining stalled users", { timeout: 10000 }, async t => {
        shared.event = new MirakurunEvent();
        const channel = createChannel();
        const device = new TunerDevice(0, {
            name: "local-stalled", types: ["GR-ALT"],
            command: `${process.execPath} -e "process.stdout.write('first');setInterval(()=>{},1000)"`
        });
        t.after(async () => { if (device.pid) { await device.kill(); } });
        const output = createStream(); output.write = () => true;
        let failures = 0;
        device.on("streamFailure", failedChannel => { assert.equal(failedChannel, channel); ++failures; });
        const released = new Promise(resolve => device.once("release", resolve));
        await device.startStream({ id: "local-stalled", priority: 0, streamSetting: { channel } }, output, channel);
        assert.ok(device.lastDataAt > 0);
        assert.equal(output.closed, false);
        await released;
        assert.equal(failures, 1);
        assert.equal(output.closed, true);
        assert.equal(device.users.length, 0);
        assert.equal(device.pid, null);
    });

    it("ends users instead of respawning a failed command", () => {
        const device = new TunerDevice(0, {
            name: "PT4K-1",
            types: ["BS4K"],
            command: "hiraku test"
        });
        const channel = createChannel();
        const output = createStream();

        device._process = new EventEmitter();
        device._process.stderr = new EventEmitter();
        device._stream = new EventEmitter();
        device._channel = channel;
        device._commandFailed = true;
        device._users.add({
            id: "Mirakurun:getServices()",
            priority: -1,
            streamSetting: { channel },
            _stream: output
        });

        let respawned = false;
        device._spawn = () => respawned = true;
        device._release();

        assert.strictEqual(output.closed, true);
        assert.strictEqual(device.users.length, 0);
        assert.strictEqual(respawned, false);
    });
});

describe("[tuner-device.spec] remote source circuit breaker", () => {
    it("groups tuner devices from the same remote source", () => {
        const tuner = createTuner();
        tuner._sourceFailureState = new Map();

        const first = {
            index: 10,
            isRemote: true,
            config: {
                remoteMirakurunHost: "10.77.0.1",
                remoteMirakurunPort: 40772
            }
        };
        const second = {
            index: 11,
            isRemote: true,
            config: {
                remoteMirakurunHost: "10.77.0.1",
                remoteMirakurunPort: 40772
            }
        };

        tuner._markSourceFailure(first);

        assert.strictEqual(tuner._isSourceFailureCoolingDown(second), true);
    });

    it("allows only one half-open probe after the source cooldown", () => {
        const tuner = createTuner();
        tuner._sourceFailureState = new Map();
        const channel = createChannel();
        const device = {
            index: 10,
            isRemote: true,
            config: {
                remoteMirakurunHost: "10.77.0.1",
                remoteMirakurunPort: 40772
            }
        };

        tuner._markSourceFailure(device);
        const state = tuner._sourceFailureState.get("10.77.0.1:40772");
        state.retryAt = Date.now() - 1;

        assert.strictEqual(tuner._beginSourceProbe(device, channel), true);
        assert.strictEqual(tuner._beginSourceProbe(device, channel), false);
        assert.strictEqual(tuner._isSourceFailureCoolingDown(device), true);
    });

    it("recovers the remote source after a stable probe", () => {
        const tuner = createTuner();
        tuner._sourceFailureState = new Map();
        const channel = createChannel();
        const device = {
            index: 10,
            isRemote: true,
            isUsing: true,
            channel,
            lastDataAt: Date.now(),
            config: {
                remoteMirakurunHost: "10.77.0.1",
                remoteMirakurunPort: 40772
            }
        };
        tuner._sourceFailureState.set("10.77.0.1:40772", {
            retryAt: 0,
            probing: true,
            generation: 3,
            probeDeviceIndex: 10,
            probeChannelKey: "GR-ALT:27"
        });

        tuner._completeSourceRecoveryProbe(device, channel, "10.77.0.1:40772", 3);

        assert.strictEqual(tuner._sourceFailureState.has("10.77.0.1:40772"), false);
    });

    it("reopens the circuit when the probe stops producing data", async () => {
        const tuner = createTuner();
        tuner._sourceFailureState = new Map();
        const channel = createChannel();
        let killed = false;
        const device = {
            index: 10,
            isRemote: true,
            isUsing: true,
            channel,
            lastDataAt: 0,
            config: {
                remoteMirakurunHost: "10.77.0.1",
                remoteMirakurunPort: 40772
            },
            kill: async () => {
                killed = true;
            }
        };
        tuner._sourceFailureState.set("10.77.0.1:40772", {
            retryAt: 0,
            probing: true,
            generation: 3,
            probeDeviceIndex: 10,
            probeChannelKey: "GR-ALT:27"
        });

        tuner._completeSourceRecoveryProbe(device, channel, "10.77.0.1:40772", 3);
        await new Promise(resolve => setImmediate(resolve));

        const state = tuner._sourceFailureState.get("10.77.0.1:40772");
        assert.strictEqual(state.probing, false);
        assert.ok(state.retryAt > Date.now());
        assert.strictEqual(killed, true);
    });
});

describe("[tuner-device.spec] reception group failover", () => {
    const satellite = type => new ChannelItem({ name: type, type, channel: "BS15_0" });
    const local = (index, group) => {
        const device = createPickDevice({ index, isRemote: false, free: true });
        device.config = { name: `local-${index}`, types: ["BS", "CS", "BS4K", "GR"], ...(group ? { group } : {}) };
        return device;
    };

    it("skips all local satellite slots after one failure, across BS/CS/BS4K but not terrestrial", () => {
        const tuner = createTuner();
        const first = local(0), second = local(1), backup = local(2, "other-site");
        tuner._handleStreamFailure(first, satellite("BS"));
        for (const type of ["BS", "CS", "BS4K"]) {
            assert.equal(tuner._pickTunerDevice([first, second, backup], satellite(type), 0), backup);
        }
        const terrestrial = new ChannelItem({ name: "GR", type: "GR", channel: "27" });
        assert.equal(tuner._pickTunerDevice([first, second], terrestrial, 0), first);
    });

    it("uses another free slot in a busy group without marking a reception failure", () => {
        const tuner = createTuner();
        const first = local(0), second = local(1), backup = local(2, "other-site");
        first.isFree = false; first.isUsing = true; first.users = [{ priority: 0 }];
        assert.equal(tuner._pickTunerDevice([first, second, backup], satellite("BS"), 0), second);
        assert.equal(tuner._sourceFailureState.size, 0);
    });

    it("permits one recovery acquisition and prevents another slot from releasing its probe", () => {
        const tuner = createTuner();
        const channel = satellite("BS");
        const first = local(0, "roof"), second = local(1, "roof"), backup = local(2, "other-site");
        tuner._handleStreamFailure(first, channel);
        const key = tuner._getGroupKey(first, channel);
        const state = tuner._sourceFailureState.get(key);
        state.retryAt = 0;
        assert.equal(tuner._beginSourceProbe(first, channel), true);
        assert.equal(tuner._beginSourceProbe(second, channel), false);
        assert.equal(tuner._pickTunerDevice([second, backup], satellite("CS"), 0), backup);
        tuner._releaseSourceProbe(second, channel);
        assert.equal(state.probing, true);
        first.isUsing = true; first.channel = channel; first.lastDataAt = Date.now();
        tuner._completeSourceRecoveryProbe(first, channel, key, state.generation);
        assert.equal(tuner._sourceFailureState.has(key), false);
        assert.equal(tuner._pickTunerDevice([second, backup], satellite("BS4K"), 0), second);
    });

    it("shares a still healthy stream in a failed group, and rejects stale stream reuse", () => {
        const tuner = createTuner();
        const channel = satellite("BS");
        const first = local(0), second = local(1), backup = local(2, "other-site");
        tuner._handleStreamFailure(first, channel);
        second.isUsing = true; second.lastDataAt = Date.now(); second.canReuseStream = () => true;
        assert.equal(tuner._pickTunerDevice([second, backup], channel, 0), second);
        second.lastDataAt = Date.now() - 6000;
        assert.equal(tuner._pickTunerDevice([second, backup], channel, 0), backup);
    });

    it("allows background jobs to use a remote group when local reception has failed", async t => {
        const tuner = createTuner();
        const channel = satellite("BS");
        const first = local(0), second = local(1), backup = local(2);
        backup.isRemote = true; backup.config.remoteMirakurunHost = "other-site";
        tuner._devices = [first, second, backup];
        tuner._readyForJobPickedDeviceSet = new Set();
        tuner._handleStreamFailure(first, channel);
        const original = global.setTimeout;
        global.setTimeout = (...args) => original(...args).unref();
        try { assert.equal(await tuner.readyForJob(channel), true); }
        finally { global.setTimeout = original; }
        assert.deepEqual([...tuner._readyForJobPickedDeviceSet], [backup]);
    });

    it("skips sibling targets when a handoff acquisition fails in their group", async t => {
        const tuner = createTuner();
        const previous = shared.config;
        shared.config = { server: { tunerHandoff: { enabled: true } } };
        t.after(() => { shared.config = previous; });
        const playing = satellite("BS");
        const requested = new ChannelItem({ name: "other BS", type: "BS", channel: "BS09_0" });
        const source = local(0, "source"), first = local(1, "roof"), sibling = local(2, "roof"), backup = local(3, "backup");
        source.isUsing = true; source.isFree = false; source.channel = playing;
        source.canHandoffTo = () => true;
        const attempted = [];
        source.handoffAllUsersTo = async target => {
            attempted.push(target);
            if (target === first) { tuner._handleStreamFailure(target, playing, new TunerStartupError("no signal", "source")); return false; }
            return true;
        };
        tuner._devices = [source, first, sibling, backup];
        tuner._readyForJobPickedDeviceSet = new Set(); tuner._handoffFailureUntil = new Map();
        assert.equal(await tuner._rebalanceForChannel(requested, 0), true);
        assert.deepEqual(attempted, [first, backup]);
    });
});

describe("[tuner-device.spec] local-only channel selection", () => {
    it("reports local availability after applying allowedTuners", () => {
        const tuner = createTuner();
        const channel = createChannel();
        tuner._devices = [
            {
                isRemote: false,
                config: {
                    name: "LOCAL-GR-1",
                    types: ["GR-ALT"]
                }
            },
            {
                isRemote: true,
                config: {
                    name: "J-GR-1",
                    types: ["GR-ALT"]
                }
            }
        ];

        assert.strictEqual(tuner.hasLocalTunerForChannel(channel), true);

        channel.setAllowedTuners(["J-GR-1"]);

        assert.strictEqual(tuner.hasLocalTunerForChannel(channel), false);
    });
});

describe("[tuner-device.spec] local-first tuner selection", () => {
    it("starts a stream on a free local tuner before a free remote tuner", () => {
        const tuner = createTuner();
        const channel = createChannel();
        const remote = createPickDevice({ index: 0, isRemote: true, free: true });
        const local = createPickDevice({ index: 1, isRemote: false, free: true });

        const picked = tuner._pickTunerDevice([remote, local], channel, 0);

        assert.strictEqual(picked, local);
    });

    it("preempts a background EPG job on a local tuner instead of using a free remote tuner", () => {
        const tuner = createTuner();
        const channel = createChannel();
        const epgChannel = createChannel();
        const localEpg = createPickDevice({
            index: 0,
            isRemote: false,
            using: true,
            channel: epgChannel,
            users: [{ id: "Mirakurun:getEPG()", priority: -1 }]
        });
        const remote = createPickDevice({ index: 1, isRemote: true, free: true });
        const runScheduleKeys = [];
        const originalJob = shared.job;
        shared.job = { runSchedule: key => runScheduleKeys.push(key) };

        try {
            const picked = tuner._pickTunerDevice([remote, localEpg], channel, 0);
            assert.strictEqual(picked, localEpg);
        } finally {
            shared.job = originalJob;
        }

        assert.deepStrictEqual(runScheduleKeys, ["EPG.Gatherer"]);
    });

    it("does not preempt a local tuner serving foreground users", () => {
        const tuner = createTuner();
        const channel = createChannel();
        const otherChannel = createChannel();
        const localViewer = createPickDevice({
            index: 0,
            isRemote: false,
            using: true,
            channel: otherChannel,
            users: [{ id: "client", priority: 0 }]
        });
        const remote = createPickDevice({ index: 1, isRemote: true, free: true });

        const picked = tuner._pickTunerDevice([localViewer, remote], channel, 0);

        assert.strictEqual(picked, remote);
    });

    it("does not preempt local tuners for background jobs", () => {
        const tuner = createTuner();
        const channel = createChannel();
        const otherChannel = createChannel();
        const localEpg = createPickDevice({
            index: 0,
            isRemote: false,
            using: true,
            channel: otherChannel,
            users: [{ id: "Mirakurun:getEPG()", priority: -1 }]
        });
        const remote = createPickDevice({ index: 1, isRemote: true, free: true });

        const picked = tuner._pickTunerDevice([localEpg, remote], channel, -1);

        assert.strictEqual(picked, remote);
    });

    it("joins an existing local stream before preempting anything", () => {
        const tuner = createTuner();
        const channel = createChannel();
        const localEpg = createPickDevice({
            index: 0,
            isRemote: false,
            using: true,
            channel: channel,
            canReuse: true,
            users: [{ id: "Mirakurun:getEPG()", priority: -1 }]
        });
        const remote = createPickDevice({ index: 1, isRemote: true, free: true });

        const picked = tuner._pickTunerDevice([remote, localEpg], channel, 0);

        assert.strictEqual(picked, localEpg);
    });

    it("does not preempt a local tuner running a user-triggered scan", () => {
        const tuner = createTuner();
        const channel = createChannel();
        const otherChannel = createChannel();
        const localScan = createPickDevice({
            index: 0,
            isRemote: false,
            using: true,
            channel: otherChannel,
            users: [{ id: "Mirakurun:API:channelScan", priority: 1 }]
        });
        const remote = createPickDevice({ index: 1, isRemote: true, free: true });

        const picked = tuner._pickTunerDevice([localScan, remote], channel, 0);

        assert.strictEqual(picked, remote);
    });
});

describe("[tuner-device.spec] background jobs during streaming", () => {
    it("falls back to a remote tuner when every local tuner is busy streaming", async () => {
        const tuner = createTuner();
        tuner._readyForJobPickedDeviceSet = new Set();
        const channel = createChannel();
        const otherChannel = createChannel();
        const localRecording = createPickDevice({
            index: 0,
            isRemote: false,
            using: true,
            channel: otherChannel,
            users: [{ id: "client", priority: 0 }]
        });
        const remote = createPickDevice({ index: 1, isRemote: true, free: true });
        tuner._devices = [localRecording, remote];

        const ready = await tuner.readyForJob(channel);

        assert.strictEqual(ready, true);
        assert.strictEqual(tuner._readyForJobPickedDeviceSet.has(remote), true);
    });

    it("waits for a held local tuner instead of falling back to a remote tuner", () => {
        const tuner = createTuner();
        tuner._readyForJobPickedDeviceSet = new Set();
        const channel = createChannel();
        const localHeld = createPickDevice({ index: 0, isRemote: false, free: true });
        const remote = createPickDevice({ index: 1, isRemote: true, free: true });
        tuner._devices = [localHeld, remote];
        tuner._readyForJobPickedDeviceSet.add(localHeld); // another job just picked it

        const originalSleep = common.sleep;
        common.sleep = async () => {
            common.sleep = originalSleep;
            throw new Error("loop-stop");
        };

        return tuner.readyForJob(channel).then(() => {
            throw new Error("should not resolve");
        }, err => {
            assert.strictEqual(err.message, "loop-stop");
            common.sleep = originalSleep;
        });
    });

    it("does not fall back to remote tuners when a local tuner is merely cooling down", async () => {
        const tuner = createTuner();
        tuner._readyForJobPickedDeviceSet = new Set();
        const channel = createChannel();
        const localCooldown = {
            index: 0,
            isRemote: false,
            isAvailable: true,
            isFree: true,
            isUsing: false,
            channel: null,
            users: [],
            getPriority: () => -2,
            canReuseStream: () => false,
            canStartStream: () => false,
            config: { name: "LOCAL-GR-1", types: ["GR-ALT"] }
        };
        const remote = createPickDevice({ index: 1, isRemote: true, free: true });
        tuner._devices = [localCooldown, remote];

        const originalSleep = common.sleep;
        common.sleep = async () => {
            common.sleep = originalSleep;
            throw new Error("loop-stop");
        };

        return tuner.readyForJob(channel).then(() => {
            throw new Error("should not resolve");
        }, err => {
            assert.strictEqual(err.message, "loop-stop");
            common.sleep = originalSleep;
        });
    });
});


describe("[tuner-device.spec] handoff ownership", () => {
    for (const cancel of [false, true]) {
        it(cancel ? "rejects a cancelled source user after PCR wait" : "reserves both endpoints until a single handoff completes", async () => {
            const { TSHandoffBuffer } = require("../lib/Mirakurun/TSHandoff");
            const original = TSHandoffBuffer.prototype.waitForSwitchPCR;
            let release;
            TSHandoffBuffer.prototype.waitForSwitchPCR = () => new Promise(resolve => { release = resolve; });
            const source = createDevice();
            const target = createDevice();
            const other = createDevice();
            const channel = createChannel();
            const user = { id: "recording", priority: 2, _stream: createStream() };
            source._channel = channel;
            source._process = {};
            source._users.add(user);
            for (const device of [source, target, other]) {
                device.detachStream = value => device._users.delete(value);
                device.endStream = value => device._users.delete(value);
                device._kill = async () => { device._process = null; device._channel = null; };
            }
            target.startStream = async (value, stream, selectedChannel) => {
                target._channel = selectedChannel || target._channel;
                target._process ||= {};
                value._stream = stream;
                target._users.add(value);
            };
            try {
                const pending = source.handoffAllUsersTo(target, 2, {});
                await Promise.resolve();
                assert.equal(await source.handoffAllUsersTo(other, 2, {}), false);
                assert.equal(await target.handoffAllUsersTo(other, 2, {}), false);
                assert.equal(other.canHandoffTo(target, 2), false);
                if (cancel) { source._users.delete(user); user._stream.closed = true; }
                release(1);
                assert.equal(await pending, !cancel);
                assert.equal(target._users.has(user), !cancel);
                assert.equal(source._users.has(user), false);
                assert.equal(other._users.size, 0);
                assert.equal(source._handoffInProgress, false);
                assert.equal(target._handoffInProgress, false);
            } finally { TSHandoffBuffer.prototype.waitForSwitchPCR = original; }
        });
    }
});
