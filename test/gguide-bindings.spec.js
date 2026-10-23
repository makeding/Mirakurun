const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { deflateSync } = require("node:zlib");
const { test } = require("node:test");
const { applyGGuidePAPPalette, parseGGuideBindings } = require("../lib/Mirakurun/GGuideBindings");

function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) { crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const chunk = Buffer.alloc(12 + data.length);
    chunk.writeUInt32BE(data.length, 0);
    chunk.write(type, 4, 4, "ascii");
    data.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
    return chunk;
}

function indexedPng() {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(1, 0);
    header.writeUInt32BE(1, 4);
    header[8] = 8;
    header[9] = 3;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), pngChunk("IHDR", header),
        pngChunk("IDAT", deflateSync(Buffer.from([0, 0]))), pngChunk("IEND", Buffer.alloc(0))]);
}

function tlv(tag, payload) {
    const value = Buffer.alloc(4 + payload.length);
    value.writeUInt16BE(payload.length + 2, 0);
    value.writeUInt16BE(tag, 2);
    payload.copy(value, 4);
    return value;
}

test("binds NAP URLs to receiver-proven top/detail member roles", () => {
    const identity = Buffer.alloc(18);
    identity.writeUInt32BE(730133, 0);
    identity.writeUInt32BE(10, 4);
    identity.writeUInt32BE(20, 8);
    const plain = Buffer.concat([Buffer.from([0, 0, 0, 14, 0xff]), tlv(1, identity),
        Buffer.from("http://nad.example/nad/730133/net_top_img1.jpg\0http://nad.example/nad/730133/net_detail_img.jpg\0http://nad.example/nad/730133/net_detail_txt.gss\0", "latin1")]);
    const [binding] = parseGGuideBindings([{ type: 0xf9, plaintext: plain, assets: [] }]);
    assert.deepEqual(binding, { kind: "nap", objectId: 730133, startRaw: 10, endRaw: 20, rawControls: "000000000000",
        members: [{ role: "top", uri: "http://nad.example/nad/730133/net_top_img1.jpg", objectId: 7301330, order: 0 },
            { role: "detailImage", uri: "http://nad.example/nad/730133/net_detail_img.jpg", objectId: 7301333 },
            { role: "detailText", uri: "http://nad.example/nad/730133/net_detail_txt.gss", objectId: 7301332 }] });
});

test("binds local f8 NAP material only when its object slot and receiver filename agree", () => {
    const objectId = 7301333;
    const identity = Buffer.alloc(12);
    identity.writeUInt32BE(objectId, 0);
    identity.writeUInt32BE(10, 4);
    identity.writeUInt32BE(0x01000000, 8);
    const end = Buffer.alloc(4);
    end.writeUInt32BE(20);
    const image = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const plain = Buffer.concat([Buffer.from([0, 12, 0xff]), tlv(1, identity), tlv(2, end),
        tlv(3, Buffer.concat([Buffer.from("detail.jpg\0", "latin1"), image]))]);
    const imageOffset = plain.indexOf(image);
    const [binding] = parseGGuideBindings([{ type: 0xf8, plaintext: plain,
        assets: [{ data: image, mimeType: "image/jpeg", imageOffset, displayable: true }] }]);
    assert.deepEqual(binding, { kind: "nap", objectId: 730133, startRaw: 10, endRaw: 20, rawControls: "01000000",
        members: [{ role: "detailImage", objectId, assetId: createHash("sha256").update(image).digest("hex"),
            mimeType: "image/jpeg", imageOffset, order: 0 }] });

    const mismatch = Buffer.concat([Buffer.from([0, 12, 0xff]), tlv(1, identity), tlv(2, end), tlv(3, Buffer.from("top1.jpg\0", "latin1"))]);
    assert.deepEqual(parseGGuideBindings([{ type: 0xf8, plaintext: mismatch, assets: [] }]), []);
});

test("keeps a NAP animation archive and its two local top-frame references distinct", () => {
    const identity = Buffer.alloc(18);
    identity.writeUInt32BE(730138, 0);
    const plain = Buffer.concat([Buffer.from([0, 0, 0, 14, 0xff]), tlv(1, identity),
        Buffer.from("http://nad.example/nad/730138/netani_730138.zip\0", "latin1")]);
    const [binding] = parseGGuideBindings([{ type: 0xf9, plaintext: plain, assets: [] }]);
    assert.deepEqual(binding.members, [
        { role: "topAnimation", uri: "http://nad.example/nad/730138/netani_730138.zip" },
        { role: "top", objectId: 7301380, order: 0 },
        { role: "top", objectId: 7301381, order: 1 },
    ]);
});

test("adds a verified PAP external palette and keeps ordered frame bindings", () => {
    const image = indexedPng();
    const palette = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([1, 2, 3])]);
    const inner = Buffer.concat([tlv(1, palette), tlv(3, image), Buffer.from([0, 0])]);
    const visual = Buffer.concat([Buffer.from([0, 8, 0xff]), inner]);
    const identity = Buffer.alloc(18);
    identity.writeUInt32BE(917127, 0);
    const plain = Buffer.concat([Buffer.from([0, 0, 0, 9, 0xff]), tlv(1, identity), tlv(2, visual)]);
    const imageOffset = plain.indexOf(image);
    const asset = { data: image, mimeType: "image/png", imageOffset, displayable: false, unsupportedReason: "missing-palette" };
    applyGGuidePAPPalette(plain, [asset]);
    assert.equal(asset.displayable, true);
    assert.equal(asset.unsupportedReason, undefined);
    assert.notEqual(asset.data, image);
    const [binding] = parseGGuideBindings([{ type: 0x56, plaintext: plain, assets: [asset] }]);
    assert.equal(binding.kind, "pap");
    assert.equal(binding.objectId, 917127);
    assert.deepEqual(binding.members, [{ role: "frame", assetId: createHash("sha256").update(asset.data).digest("hex"), mimeType: "image/png", imageOffset, order: 0 }]);
});

test("parses OBJ12 media and index URI without inventing timestamp meaning", () => {
    const identity = Buffer.alloc(14);
    identity.writeUInt32BE(917121, 0);
    const image = Buffer.from([0xff, 0xd8, 0xff]);
    const media = parseGGuideBindings([{ type: 0xf5, plaintext: Buffer.concat([Buffer.from([0, 12, 0xff]), tlv(1, identity)]),
        assets: [{ data: image, mimeType: "image/jpeg", imageOffset: 42, displayable: true }] }]);
    assert.equal(media[0].kind, "obj12");
    assert.equal(media[0].objectId, 917121);
    const index = Buffer.concat([Buffer.from([0x41, 0x7a, 0x51, 0x49, 0x3d, 4, 0x4d, 0, 13, 0xfe, 0x81, 23]),
        Buffer.from("Image/G-Guide-OBJ12-PNG\x16/OBJ12:917121/mjS1A5Ru", "latin1"), Buffer.from([0x41, 0x7b, 0xb3, 0xf8])]);
    const bindings = parseGGuideBindings([{ type: 0xdf, plaintext: index, assets: [] }]);
    assert.deepEqual(bindings, [{ kind: "obj12", objectId: 917121,
        members: [{ role: "media", uri: "/OBJ12:917121/mjS1A5Ru", mimeType: "Image/G-Guide-OBJ12-PNG" }] }]);
});

test("keeps separately received OBJ12 media and index records joinable by object ID", () => {
    const identity = Buffer.alloc(14);
    identity.writeUInt32BE(42, 0);
    const image = Buffer.from([0xff, 0xd8, 0xff]);
    const index = Buffer.concat([Buffer.from([0, 0, 0, 1, 0x20, 4, 0x4d, 0, 0, 0, 42, 24]),
        Buffer.from("Image/G-Guide-OBJ12-JPEG\x13/OBJ12:42/image.jpg", "latin1"), Buffer.from([0, 0, 0, 2])]);
    const bindings = parseGGuideBindings([
        { type: 0xf5, plaintext: Buffer.concat([Buffer.from([0, 12, 0xff]), tlv(1, identity)]), assets: [{ data: image, mimeType: "image/jpeg", imageOffset: 30, displayable: true }] },
        { type: 0xdf, plaintext: index, assets: [] }
    ]);
    assert.equal(bindings.length, 2);
    assert.deepEqual(bindings.map(binding => binding.objectId), [42, 42]);
    assert.equal(bindings[0].members[0].assetId, createHash("sha256").update(image).digest("hex"));
    assert.equal(bindings[1].members[0].uri, "/OBJ12:42/image.jpg");
});

test("rejects malformed TLV families without emitting a binding", () => {
    assert.deepEqual(parseGGuideBindings([{ type: 0xf9, plaintext: Buffer.from([0, 0, 0, 14, 0xff, 0, 20, 0, 1]), assets: [] }]), []);
});


test("joins independent OBJ12 records and replaces a refreshed media slot", () => {
    const { mergeMembers } = require("../lib/Mirakurun/GGuideStore");
    const joined = mergeMembers([{ role: "media", uri: "/OBJ12:42/a" }], [{ role: "media", order: 0, assetId: "old" }]);
    assert.deepEqual(joined, [{ role: "media", uri: "/OBJ12:42/a", order: 0, assetId: "old" }]);
    assert.deepEqual(mergeMembers(joined, [{ role: "media", order: 0, assetId: "new" }]),
        [{ role: "media", uri: "/OBJ12:42/a", order: 0, assetId: "new" }]);
});
