const assert = require("node:assert/strict");
const { createCipheriv } = require("node:crypto");
const { deflateSync } = require("node:zlib");
const { test } = require("node:test");
const { TsCrc32 } = require("@chinachu/aribts");
const { decodeGGuideModule, GGuideDecodeError } = require("../lib/Mirakurun/GGuideDecoder");
const { GGuideCarousel } = require("../lib/Mirakurun/GGuideCarousel");

const key = Buffer.from("0123456789abcdef", "hex");

function pngCrc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 4, "ascii");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(pngCrc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}

function png(withPalette = true) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 3;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", header),
        ...(withPalette ? [chunk("PLTE", Buffer.from([0, 0, 0]))] : []),
        chunk("IDAT", deflateSync(Buffer.from([0, 0]))),
        chunk("IEND", Buffer.alloc(0))
    ]);
}

function encrypt(data) {
    const padded = Buffer.alloc(Math.ceil(data.length / 8) * 8);
    data.copy(padded);
    const cipher = createCipheriv("des-ede3-ecb", Buffer.concat([key, key, key]), null);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]);
}

function moduleWithRecord(plaintext, { compressed = false } = {}) {
    const payload = compressed ? Buffer.concat([Buffer.alloc(2), deflateSync(plaintext)]) : plaintext;
    const encrypted = encrypt(payload);
    const record = Buffer.alloc(15);
    record[0] = 0x0d;
    record[1] = 0xf5;
    record.writeUInt16BE(0x4151, 2);
    record.writeUInt16BE((compressed ? 0x4000 : 0) | encrypted.length / 8, 9);
    record.writeUInt16BE(payload.length, 13);
    const wrapper = Buffer.alloc(28);
    wrapper.writeUInt16BE(14, 0);
    wrapper.write("MM000000BIN", 4, "ascii");
    wrapper.writeUInt16BE(0x0d7f, 16);
    return Buffer.concat([wrapper, record, encrypted]);
}

function section(tableId, payload) {
    const bytes = Buffer.alloc(8);
    bytes[0] = tableId;
    bytes[1] = 0xb0;
    bytes[3] = 0;
    bytes[4] = 1;
    bytes[5] = 0xc1;
    const body = Buffer.concat([bytes, payload]);
    const length = body.length - 3 + 4;
    body.writeUInt16BE(0xb000 | length, 1);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(TsCrc32.calc(body) >>> 0, 0);
    return Buffer.concat([body, checksum]);
}

function packet(pid, data, continuity = 0) {
    const output = Buffer.alloc(188, 0xff);
    output[0] = 0x47;
    output[1] = 0x40 | (pid >> 8);
    output[2] = pid & 0xff;
    output[3] = 0x10 | (continuity & 15);
    output[4] = 0;
    data.copy(output, 5);
    return output;
}

test("decodes a compressed GGuide record and extracts a displayable PNG", () => {
    const result = decodeGGuideModule(moduleWithRecord(png(), { compressed: true }), key);
    assert.equal(result.moduleName, "MM000000.BIN");
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].compression, 1);
    assert.equal(result.assets.length, 1);
    assert.deepEqual(result.assets[0], {
        data: png(), mimeType: "image/png", width: 1, height: 1, displayable: true,
        recordOffset: 28, recordType: 0xf5, imageOffset: 0
    });
});

test("marks indexed PNG without its palette as unsupported", () => {
    const result = decodeGGuideModule(moduleWithRecord(png(false)), key);
    assert.equal(result.assets.length, 1);
    assert.equal(result.assets[0].displayable, false);
    assert.equal(result.assets[0].unsupportedReason, "missing-palette");
});

test("rejects wrong keys, malformed record lengths, and arbitrary image signatures", () => {
    assert.throws(() => decodeGGuideModule(moduleWithRecord(png(), { compressed: true }), Buffer.alloc(8)), GGuideDecodeError);
    const malformed = moduleWithRecord(Buffer.from("not an image"));
    malformed.writeUInt16BE(0x3fff, 37);
    assert.throws(() => decodeGGuideModule(malformed, key), GGuideDecodeError);
    const excessiveMetadata = moduleWithRecord(Buffer.from("not an image"));
    excessiveMetadata[36] = 9;
    assert.throws(() => decodeGGuideModule(excessiveMetadata, key), GGuideDecodeError);
    const opaque = moduleWithRecord(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
    assert.equal(decodeGGuideModule(opaque, key).assets.length, 0);
});

test("reassembles only GGuide DSM-CC modules announced by the selected service", () => {
    const received = [];
    const carousel = new GGuideCarousel({ serviceId: 1, onModule: module => received.push(module), maxModuleBytes: 16, maxBufferedBytes: 32 });
    const pat = section(0x00, Buffer.from([0, 1, 0xe1, 0x00]));
    const pmt = section(0x02, Buffer.from([0xe1, 0xff, 0xf0, 0, 0x0d, 0xe1, 1, 0xf0, 4, 0xfd, 2, 0, 0x0a]));
    const diiPayload = Buffer.alloc(42);
    diiPayload.writeUInt16BE(0x1103, 0);
    diiPayload.writeUInt16BE(0x1002, 2);
    diiPayload.writeUInt32BE(1, 12);
    diiPayload.writeUInt16BE(4, 16);
    diiPayload.writeUInt16BE(1, 30);
    diiPayload.writeUInt16BE(2, 32);
    diiPayload.writeUInt32BE(4, 34);
    diiPayload[38] = 1;
    const dii = section(0x3b, diiPayload);
    const ddb = section(0x3c, Buffer.from([
        0x11, 3, 0x10, 3, 0, 0, 0, 1, 0, 0, 0, 10, 0, 2, 1, 0, 0, 0, 0x74, 0x65, 0x73, 0x74
    ]));
    carousel.write(Buffer.concat([packet(0, pat), packet(0x100, pmt), packet(0x101, dii), packet(0x101, ddb)]));
    assert.deepEqual(received, [{ serviceId: 1, pid: 0x101, downloadId: 1, moduleId: 2, moduleVersion: 1, data: Buffer.from("test") }]);
    assert.deepEqual(carousel.getStats(), { packets: 4, syncLoss: 0, malformed: 0, completed: 1, discarded: 0, bufferedBytes: 0 });
    carousel.close();
    assert.throws(() => carousel.write(Buffer.alloc(0)), /closed/);
});
