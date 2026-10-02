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

    it("waits for the first remote stream data", async () => {
        const device = createDevice();
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
});

describe("[tuner-device.spec] failed command release", () => {
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
        const tuner = Object.create(Tuner.prototype);
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
        const tuner = Object.create(Tuner.prototype);
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
        const tuner = Object.create(Tuner.prototype);
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
        const tuner = Object.create(Tuner.prototype);
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

describe("[tuner-device.spec] local-only channel selection", () => {
    it("reports local availability after applying allowedTuners", () => {
        const tuner = Object.create(Tuner.prototype);
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
        const tuner = Object.create(Tuner.prototype);
        const channel = createChannel();
        const remote = createPickDevice({ index: 0, isRemote: true, free: true });
        const local = createPickDevice({ index: 1, isRemote: false, free: true });

        const picked = tuner._pickTunerDevice([remote, local], channel, 0);

        assert.strictEqual(picked, local);
    });

    it("preempts a background EPG job on a local tuner instead of using a free remote tuner", () => {
        const tuner = Object.create(Tuner.prototype);
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
        const tuner = Object.create(Tuner.prototype);
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
        const tuner = Object.create(Tuner.prototype);
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
        const tuner = Object.create(Tuner.prototype);
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
        const tuner = Object.create(Tuner.prototype);
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
        const tuner = Object.create(Tuner.prototype);
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
        const tuner = Object.create(Tuner.prototype);
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
        const tuner = Object.create(Tuner.prototype);
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
