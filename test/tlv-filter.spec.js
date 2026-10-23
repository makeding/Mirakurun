const assert = require("node:assert/strict");
const { test } = require("node:test");

// status.ts owns a repeating timer in the server.  The parser only needs these
// counters, and isolating them keeps this focused unit test process finite.
const statusPath = require.resolve("../lib/Mirakurun/status");
const status = { streamCount: { tsFilter: 0 }, epg: {} };
require.cache[statusPath] = {
    id: statusPath,
    filename: statusPath,
    loaded: true,
    exports: { __esModule: true, default: status }
};

const _ = require("../lib/Mirakurun/_").default;
_.config = { server: {} };

const TLVFilter = require("../lib/Mirakurun/TLVFilter").default;
const MHEPG = require("../lib/Mirakurun/MHEPG").default;

const networkId = 0x7880;
const serviceId = 0x1234;

function channel(services = []) {
    return { type: "BS4K", channel: "BS01_0", getServices: () => services };
}

function nit() {
    return {
        tableId: "TLV-NIT[actual]",
        networkId,
        tlvStreams: [],
        networkDescriptors: [{ tag: "remoteControlKey", keys: [{ serviceId, remoteControlKeyId: 9 }] }]
    };
}

function sdt() {
    return {
        tableId: "SDT[actual]",
        tlvStreamId: 0x40,
        originalNetworkId: networkId,
        services: [{
            serviceId,
            freeCAMode: false,
            descriptors: [{ tag: "mhServiceDescriptor", serviceName: Buffer.from("4K test"), serviceType: 0xad }]
        }]
    };
}

function plt() {
    return {
        tableId: "PLT",
        version: 1,
        packages: [{ mmtPackageId: Buffer.from([serviceId >> 8, serviceId]), locationInfo: { packetId: 0x234 } }]
    };
}

function event(eventId, overrides = {}) {
    return {
        tableId: "EIT[schedule basic]",
        tableIdNumber: 0x50,
        tableIndex: 0,
        serviceId,
        versionNumber: 1,
        currentNextIndicator: true,
        sectionNumber: 0,
        lastSectionNumber: 0,
        tlvStreamId: 0x40,
        originalNetworkId: networkId,
        segmentLastSectionNumber: 0,
        lastTableId: 0x50,
        lastTableIndex: 0,
        events: [{
            eventId,
            // MJD 60000, 12:00:00 JST.  The mocked program store deliberately
            // accepts historical timestamps so descriptor mapping is isolated.
            startTime: 0xea60120000,
            duration: 0x010000,
            runningStatus: 0,
            freeCAMode: false,
            descriptors: []
        }],
        ...overrides
    };
}

function programStore(existing = []) {
    const items = new Map(existing.map(item => [item.id, { ...item }]));
    const calls = { prepareEvent: [], add: [], set: [] };
    return {
        calls,
        prepareEvent(id, startAt, duration) {
            calls.prepareEvent.push({ id, startAt, duration });
            // Mirror Program.prepareEvent's parser contract: a reused ID evicts
            // the old current event before MHEPG constructs its replacement.
            const old = items.get(id);
            if (old && (old.startAt !== startAt || old.duration !== duration)) {
                items.delete(id);
                return true;
            }
            return false;
        },
        exists(id) { return items.has(id); },
        get(id) { return items.get(id) || null; },
        add(item) { calls.add.push(item); items.set(item.id, { ...item }); },
        set(id, props) {
            calls.set.push({ id, props });
            items.set(id, { ...items.get(id), ...props });
        }
    };
}

test("TLVFilter replays SDT after PLT and NIT prerequisites arrive", t => {
    const filter = new TLVFilter({ channelItem: channel(), parseNIT: true, parseSDT: true });
    t.after(() => filter.close());
    const seen = [];
    filter.on("network", value => seen.push({ name: "network", value }));
    filter.on("streamInfo", value => seen.push({ name: "streamInfo", value }));
    filter.on("services", value => seen.push({ name: "services", value }));

    // Real broadcasts can deliver SDT before PLT, and PLT before NIT.
    filter._onSDT(sdt());
    filter._onPLT(plt());
    assert.deepEqual(seen, []);
    filter._onNIT(nit());

    assert.deepEqual(seen.map(value => value.name), ["network", "streamInfo", "services"]);
    assert.deepEqual(seen[1].value, { streamId: 0x40, networkId });
    assert.deepEqual(seen[2].value, [{
        networkId,
        serviceId,
        name: "4K test",
        type: 0xad,
        logoId: -1,
        remoteControlKeyId: 9
    }]);
});

test("TLVFilter rejects EIT from an unrelated network", t => {
    const store = programStore();
    _.program = store;
    const filter = new TLVFilter({ channelItem: channel(), networkId, parseEIT: true });
    t.after(() => { filter.close(); _.program = undefined; });
    filter._parseServiceIds = new Set([serviceId]);

    filter._onEIT(event(1, { originalNetworkId: networkId + 1 }));
    assert.deepEqual(store.calls, { prepareEvent: [], add: [], set: [] });
});

test("MHEPG atomically records 2160p HEVC metadata and all audio components once", () => {
    const store = programStore();
    _.program = store;
    const epg = new MHEPG();
    const table = event(7);
    table.events[0].descriptors = [
        { tag: "videoComponent", componentTag: 1, videoResolution: 6, videoScanFlag: true, videoFrameRate: 8, videoTransferCharacteristics: 5 },
        { tag: "mhAudioComponent", componentTag: 2, componentType: 1, mainComponentFlag: true, samplingRate: 7, iso639LanguageCode: 0x6a706e },
        { tag: "mhAudioComponent", componentTag: 3, componentType: 2, mainComponentFlag: false, samplingRate: 6, iso639LanguageCode: 0x656e67 }
    ];

    epg.write(table);
    epg.write(table);

    assert.equal(store.calls.prepareEvent.length, 2, "each broadcast observation checks for event-ID reuse");
    assert.equal(store.calls.add.length, 1);
    assert.equal(store.calls.set.length, 0, "initial descriptors belong in the single add record");
    const props = store.calls.add[0];
    assert.deepEqual(props.video, {
        type: "h.265",
        resolution: "2160p",
        streamContent: 0x09,
        componentType: 1,
        frameRate: "59.94",
        transferCharacteristics: "bt2100-hlg"
    });
    assert.deepEqual(props.audios, [
        { componentType: 1, componentTag: 2, isMain: true, samplingRate: 48000, langs: ["jpn"] },
        { componentType: 2, componentTag: 3, isMain: false, samplingRate: 44100, langs: ["eng"] }
    ]);
    epg.end();
    _.program = undefined;
});


test("MHEPG prepares an event ID again when its broadcast time is reused", () => {
    const id = Number(`${networkId}${serviceId.toString().padStart(5, "0")}00008`);
    const store = programStore([{ id, startAt: 1, duration: 1 }]);
    _.program = store;
    const epg = new MHEPG();
    const table = event(8);

    epg.write(table);

    assert.equal(store.calls.prepareEvent.length, 1);
    assert.equal(store.calls.add.length, 1, "prepareEvent must make a reused event writable as a fresh program");
    assert.equal(store.calls.set.length, 0);
    epg.end();
    _.program = undefined;
});
