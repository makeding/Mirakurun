const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PassThrough } = require("node:stream");

// TLVDecoder shares the server status singleton.  A small local replacement
// makes the child-process pipeline test deterministic and leaves no timer
// owned by status.ts running after this test file exits.
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = {
    id: statusPath,
    filename: statusPath,
    loaded: true,
    exports: {
        __esModule: true,
        default: { streamCount: { decoder: 0 }, errorCount: { decoderRespawn: 0 } }
    }
};

const TLVDecoder = require("../lib/Mirakurun/TLVDecoder").default;

test("TLVDecoder leaves raw TLV untouched when decode=0", () => {
    const output = new PassThrough();
    const input = TLVDecoder.create({
        output,
        outputFormat: "tlv",
        tlvDecoder: "/definitely/not/a-decoder",
        disableDecoder: true
    });
    assert.equal(input, output);
    output.destroy();
});

test("TLVDecoder keeps B61 decryption and TLV-to-TS conversion as separate stages", async () => {
    const output = new PassThrough();
    const chunks = [];
    output.on("data", chunk => chunks.push(chunk));
    const ended = new Promise(resolve => output.once("end", resolve));
    const input = TLVDecoder.create({
        output,
        outputFormat: "ts",
        tlvDecoder: "/bin/cat",
        tlvToTsDecoder: "/bin/cat"
    });
    input.end(Buffer.from("encrypted-tlv"));
    await ended;
    assert.equal(Buffer.concat(chunks).toString(), "encrypted-tlv");
});

test("TLVDecoder still converts decode=0 TLV output to requested TS", async () => {
    const output = new PassThrough();
    const chunks = [];
    output.on("data", chunk => chunks.push(chunk));
    const ended = new Promise(resolve => output.once("end", resolve));
    const input = TLVDecoder.create({
        output,
        outputFormat: "ts",
        tlvDecoder: "/definitely/not/a-decoder",
        tlvToTsDecoder: "/bin/cat",
        disableDecoder: true
    });
    input.end(Buffer.from("raw-tlv"));
    await ended;
    assert.equal(Buffer.concat(chunks).toString(), "raw-tlv");
});
