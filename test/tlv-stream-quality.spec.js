const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const { test } = require("node:test");

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
const Event = require("../lib/Mirakurun/Event").default;
const { Server } = require("../lib/Mirakurun/Server");

function mmtpPacket(sequenceNumber, headerType = 0x61, endpoint = 0) {
    const mmtpOffset = headerType === 0x61 ? 7 : 49;
    const packet = Buffer.alloc(mmtpOffset + 12);
    packet[0] = 0x7f;
    packet[1] = 0x03;
    packet.writeUInt16BE(packet.length - 4, 2);
    packet[5] = 0x10; // CID 1
    packet[6] = headerType;
    if (headerType === 0x60) {
        packet[13] = endpoint;
    }
    packet.writeUInt16BE(0x1234, mmtpOffset + 2);
    packet.writeUInt32BE(sequenceNumber, mmtpOffset + 8);
    return packet;
}

function unknownTLVPacket() {
    return Buffer.from([0x7f, 0xff, 0x00, 0x00]);
}

test("TLV stream quality estimates MMTP sequence gaps without counting reordering", t => {
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const filter = new TLVFilter({
        channelItem: { type: "BS4K", channel: "BS01_0", getServices: () => [] },
        output
    });
    t.after(() => filter.close());

    // Start at 0xffffffff to cover 32-bit wraparound.  The injected 2 -> 5
    // discontinuities inject three missing MMTP packets, then a late packet
    // repairs one of those estimates instead of being reported as loss.
    filter.write(Buffer.concat([
        unknownTLVPacket(),
        mmtpPacket(0xffffffff, 0x60),
        mmtpPacket(0),
        mmtpPacket(2),
        mmtpPacket(5),
        mmtpPacket(5),
        mmtpPacket(4)
    ]));

    const info = filter.streamInfo["3"];
    assert.equal(info.packet, 6);
    assert.equal(info.drop, 2);
    assert.deepEqual(info.measurement, {
        method: "mmtp-packet-sequence-estimate",
        measuredPackets: 6,
        comparedPackets: 5,
        baselinePackets: 1,
        unavailablePackets: 0,
        duplicatePackets: 1,
        reorderedPackets: 1,
        resyncPackets: 0
    });
    assert.deepEqual(filter.streamInfo["255"].measurement, {
        method: "mmtp-packet-sequence-estimate",
        measuredPackets: 0,
        comparedPackets: 0,
        baselinePackets: 0,
        unavailablePackets: 1,
        duplicatePackets: 0,
        reorderedPackets: 0,
        resyncPackets: 0
    });
});

test("TLV stream quality keeps a continuous measured stream at zero gaps", t => {
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const filter = new TLVFilter({
        channelItem: { type: "BS4K", channel: "BS01_0", getServices: () => [] },
        output
    });
    t.after(() => filter.close());

    filter.write(Buffer.concat([mmtpPacket(10, 0x60), mmtpPacket(11), mmtpPacket(12)]));
    const info = filter.streamInfo["3"];
    assert.equal(info.drop, 0);
    assert.equal(info.measurement.comparedPackets, 2);
    assert.equal(info.measurement.unavailablePackets, 0);
});

test("TLV stream quality resynchronizes a large sequence jump without inventing loss", t => {
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const filter = new TLVFilter({
        channelItem: { type: "BS4K", channel: "BS01_0", getServices: () => [] },
        output
    });
    t.after(() => filter.close());

    filter.write(Buffer.concat([mmtpPacket(1, 0x60), mmtpPacket(5000)]));
    const info = filter.streamInfo["3"];
    assert.equal(info.drop, 0);
    assert.equal(info.measurement.resyncPackets, 1);
});

test("TLV stream quality resets only a changed HCIP endpoint's CID baseline", t => {
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const filter = new TLVFilter({
        channelItem: { type: "BS4K", channel: "BS01_0", getServices: () => [] },
        output
    });
    t.after(() => filter.close());

    filter.write(Buffer.concat([mmtpPacket(1, 0x60, 1), mmtpPacket(100, 0x60, 2), mmtpPacket(101)]));
    const info = filter.streamInfo["3"];
    assert.equal(info.drop, 0);
    assert.equal(info.measurement.baselinePackets, 2);
    assert.equal(info.measurement.comparedPackets, 1);
});

test("the tuner API exposes a non-zero injected MMTP gap and measurement confidence", async t => {
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const filter = new TLVFilter({
        channelItem: { type: "BS4K", channel: "BS01_0", getServices: () => [] },
        output
    });
    t.after(() => filter.close());
    filter.write(Buffer.concat([mmtpPacket(1, 0x60), mmtpPacket(3)]));

    _.config = { server: { port: 0, disableIPv6: true, disableWebUI: true,
        allowIPv4CidrRanges: ["127.0.0.0/8"], allowIPv6CidrRanges: [], allowOrigins: [] }, tuners: [] };
    _.event = new Event();
    _.job = { add() {}, addSchedule() {} };
    _.program = { history: { flush: async () => {} } };
    _.tuner = { devices: [{
        index: 0, name: "quality probe", types: ["BS4K"], command: null, pid: null,
        users: [{ id: "quality", priority: 0, streamInfo: filter.streamInfo }],
        isAvailable: true, isRemote: false, isFree: false, isUsing: true, isFault: false
    }] };
    const server = new Server();
    server.testMode = true;
    t.after(async () => {
        for (const listener of server.servers) { listener.closeAllConnections(); }
        await server.deinit();
    });
    await server.init();
    const port = [...server.servers][0].address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/tuners`);
    assert.equal(response.status, 200);
    const user = (await response.json())[0].users[0];
    assert.equal(user.streamInfo["3"].drop, 1);
    assert.equal(user.streamInfo["3"].measurement.comparedPackets, 1);
    assert.equal(user.streamInfo["3"].measurement.unavailablePackets, 0);
});
