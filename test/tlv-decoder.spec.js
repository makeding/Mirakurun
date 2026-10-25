const assert = require("node:assert/strict");
const { test } = require("node:test");
const { PassThrough } = require("node:stream");
const { once } = require("node:events");

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

test("cancelling output during stdin finalization does not emit a spurious error", async t => {
    const output = new PassThrough();
    const input = new TLVDecoder({ output,
        command: `${process.execPath} -e "setInterval(() => {}, 1000)"` });
    const child = input._process;
    const exited = once(child, "close");
    t.after(() => { output.destroy(); input.destroy(); child.kill("SIGKILL"); });
    const errors = [];
    input.on("error", error => errors.push(error));
    input.write(Buffer.from([0x7f]));
    input.end();
    output.destroy();
    await exited;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(errors, []);
    assert.equal(input.destroyed, true);
});

test("successful finalization waits for delayed child output and exit", async t => {
    const output = new PassThrough();
    const chunks = [];
    output.on("data", chunk => chunks.push(chunk));
    const ended = once(output, "end");
    const input = new TLVDecoder({ output, command: `${process.execPath} -e "` +
        `const chunks=[];process.stdin.on('data',b=>chunks.push(b));` +
        `process.stdin.on('end',()=>setTimeout(()=>process.stdout.end(Buffer.concat(chunks)),50))"` });
    const child = input._process;
    const exited = once(child, "close");
    t.after(() => { output.destroy(); input.destroy(); child.kill("SIGKILL"); });
    const expected = Buffer.alloc(256 * 1024, 0x7f);
    input.end(expected);
    await ended;
    await exited;
    assert.deepEqual(Buffer.concat(chunks), expected);
    assert.equal(child.exitCode, 0);
    assert.equal(child.signalCode, null);
});

test("startup timeout does not include waiting for the first input", async t => {
    const output = new PassThrough();
    const chunks = [];
    output.on("data", chunk => chunks.push(chunk));
    const input = new TLVDecoder({ output, command: "/bin/cat", startupTimeout: 100 });
    const child = input._process;
    const exited = once(child, "close");
    t.after(() => { output.destroy(); input.destroy(); child.kill("SIGKILL"); });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(input.destroyed, false);
    const ended = once(output, "end");
    input.end(Buffer.from("late input"));
    await ended;
    await exited;
    assert.equal(Buffer.concat(chunks).toString(), "late input");
});
