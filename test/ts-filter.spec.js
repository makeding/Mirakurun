const { it } = require("node:test");
const assert = require("node:assert/strict");
const { Writable } = require("node:stream");
const { TsCrc32 } = require("@chinachu/aribts");

const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = {
    id: statusPath, filename: statusPath, loaded: true,
    exports: { __esModule: true, default: { streamCount: { tsFilter: 0 } } }
};
const shared = require("../lib/Mirakurun/_").default;
shared.config = { server: {} };
const TSFilter = require("../lib/Mirakurun/TSFilter").default;

function packet(pid, payload, counter = 0) {
    const p = Buffer.alloc(188, 0xff);
    p[0] = 0x47;
    p[1] = (pid >> 8) | (payload ? 0x40 : 0);
    p[2] = pid & 255;
    p[3] = 0x10 | counter;
    if (payload) {
        p[4] = 0;
        payload.copy(p, 5);
    }
    return p;
}

function section(bytes) {
    const b = Buffer.from([...bytes, 0, 0, 0, 0]);
    b.writeUInt16BE(0xb000 | (b.length - 3), 1);
    b.writeInt32BE(TsCrc32.calc(b.subarray(0, -4)), b.length - 4);
    return b;
}

function pmt(pids, version = 0, current = true, sid = 41010) {
    return packet(0x102, section([
        2, 0, 0, sid >> 8, sid & 255, 0xc0 | (version << 1) | Number(current), 0, 0,
        0xe1, 0xff, 0xf0, 0,
        ...pids.flatMap(pid => [2, 0xe0 | (pid >> 8), pid & 255, 0xf0, 0])
    ]), version);
}

async function filter(t) {
    const chunks = [];
    const f = new TSFilter({ serviceId: 41010, output: new Writable({
        write(chunk, encoding, done) { chunks.push(chunk); done(); }
    }) });
    t.after(() => f.close());
    f.write(packet(0, section([0, 0, 0, 0x7d, 0x76, 0xc1, 0, 0, 0xa0, 0x32, 0xe1, 2])));
    await new Promise(setImmediate);
    return { f, chunks, take() {
        const bytes = Buffer.concat(chunks.splice(0));
        const pids = [];
        for (let i = 0; i < bytes.length; i += 188) pids.push(bytes.readUInt16BE(i + 1) & 0x1fff);
        return pids;
    } };
}

it("replaces old video/audio/data PIDs at the PMT packet, including switches back", async t => {
    const x = await filter(t);
    x.f.write(Buffer.concat([pmt([0x100, 0x110, 0x140]), packet(0x100), packet(0x110)]));
    assert.deepEqual(x.take(), [0x102, 0x100, 0x110]);
    x.f.write(Buffer.concat([
        pmt([0x200, 0x210], 1), ...[0x100, 0x110, 0x140, 0x200, 0x210, 0x1ff, 0x14].map(pid => packet(pid))
    ]));
    assert.deepEqual(x.take(), [0x102, 0x200, 0x210, 0x1ff, 0x14]);
    x.f.write(Buffer.concat([pmt([0x100, 0x110], 2), packet(0x200), packet(0x210), packet(0x100), packet(0x110)]));
    assert.deepEqual(x.take(), [0x102, 0x100, 0x110]);
});

it("ignores future and other-service PMTs when selecting payload PIDs", async t => {
    const x = await filter(t);
    x.f.write(pmt([0x100]));
    x.take();
    x.f.write(Buffer.concat([pmt([0x200], 1, false), pmt([0x200], 2, true, 41008), packet(0x100), packet(0x200)]));
    assert.deepEqual(x.take(), [0x102, 0x102, 0x100]);
});

it("replaces PCR and CA PIDs while retaining all current ES and their CA descriptors", async t => {
    const x = await filter(t);
    const data = (pcr, ca, esCa) => ({
        program_number: 41010, current_next_indicator: 1, PCR_PID: pcr,
        program_info: [{ descriptor_tag: 0xc1 }, { descriptor_tag: 9, CA_PID: ca }],
        streams: [0x200, 0x210].map(elementary_PID => ({ elementary_PID, ES_info: [{ descriptor_tag: 9, CA_PID: esCa }] }))
    });
    x.f._onPMT(0x102, data(0x1ff, 0x1000, 0x1001));
    x.f._onPMT(0x102, data(0x2ff, 0x1002, 0x1003));
    x.f.write(Buffer.concat([0x1ff, 0x1000, 0x1001, 0x2ff, 0x1002, 0x1003, 0x200, 0x210].map(pid => packet(pid))));
    assert.deepEqual(x.take(), [0x2ff, 0x1002, 0x1003, 0x200, 0x210]);
});
