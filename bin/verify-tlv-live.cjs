#!/usr/bin/env node
/*
 * Copyright 2026 kanreisa
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

"use strict";

// Opt-in, live BS4K acceptance.  It deliberately starts a private in-process
// Mirakurun Server against a real Hiraku tuner source; it never writes config,
// databases, captures, or credentials to disk.
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const http = require("node:http");
const { once } = require("node:events");

const MAX_CASE_BYTES = 32 * 1024 * 1024;
const STDERR_LIMIT = 128 * 1024;
const retainedStderr = [];
let retainedStderrBytes = 0;
let liveDiagnostics = () => ({});

function usage(exitCode = 0) {
    console.log(`Usage: ${process.argv[1]} --hiraku PATH --host HOST:PORT --secret-env ENV \\
  [--mode BS4K1] [--channel BS17_0] [--service-id 101] [--network-id 11] \\
  [--stream-id 45328] --converter COMMAND [--seconds 12]

The Hiraku secret is read only from ENV. It is redacted from all output.`);
    process.exit(exitCode);
}

function parseArgs(argv) {
    const result = {
        mode: "BS4K1", channel: "BS17_0", serviceId: 101, networkId: 11,
        streamId: 45328, seconds: 12
    };
    for (let i = 0; i < argv.length; i++) {
        const key = argv[i];
        if (key === "--help" || key === "-h") { usage(); }
        if (!key.startsWith("--") || i + 1 >= argv.length) { usage(2); }
        result[key.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    }
    for (const key of ["hiraku", "host", "secretEnv", "converter"]) {
        if (!result[key]) { console.error(`missing --${key.replace(/[A-Z]/g, c => "-" + c.toLowerCase())}`); usage(2); }
    }
    for (const key of ["serviceId", "networkId", "streamId", "seconds"]) {
        result[key] = Number(result[key]);
        if (!Number.isSafeInteger(result[key]) || result[key] <= 0) { throw new Error(`invalid --${key}`); }
    }
    if (result.seconds < 5) { throw new Error("--seconds must be at least 5 for a decodable 4K capture"); }
    return result;
}

const options = parseArgs(process.argv.slice(2));
const secret = process.env[options.secretEnv];
if (!secret) { throw new Error(`environment variable ${options.secretEnv} is empty`); }

function quote(value) {
    if (/^[A-Za-z0-9_./:=,@+%-]+$/.test(value)) { return value; }
    if (/["'\\]/.test(value)) { throw new Error("Hiraku secret contains unsupported quoting characters"); }
    return `"${value}"`;
}

function redact(value) {
    return String(value).split(secret).join("[REDACTED]");
}

function print(value) {
    process.stdout.write(redact(JSON.stringify(value)) + "\n");
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function httpRequest(url, onResponse) {
    return new Promise((resolve, reject) => {
        let responded = false;
        const req = http.get(url, res => { responded = true; onResponse(res, req, resolve, reject); });
        // Deliberate client cancellation produces a socket error after the
        // response callback owns completion. It is not a request failure.
        req.once("error", error => { if (!responded) { reject(error); } });
    });
}

function openRequest(url) {
    let settled = false;
    let rejectResponse;
    let req;
    const response = new Promise((resolve, reject) => {
        rejectResponse = reject;
        req = http.get(url, res => {
            settled = true;
            resolve({ req, res });
        });
        req.once("error", error => { if (!settled) { reject(error); } });
    });
    return { response, get req() { return req; }, reject: error => rejectResponse(error) };
}

function readResponse(res, maxBytes = MAX_CASE_BYTES) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        res.on("data", chunk => {
            bytes += chunk.length;
            if (bytes > maxBytes) { reject(new Error(`response exceeded ${maxBytes} bytes`)); res.destroy(); return; }
            chunks.push(chunk);
        });
        res.once("end", () => resolve({ status: res.statusCode, bytes, body: Buffer.concat(chunks), aborted: false }));
        res.once("aborted", () => resolve({ status: res.statusCode, bytes, body: Buffer.concat(chunks), aborted: true }));
        res.once("error", reject);
    });
}

async function getJSON(url) {
    const value = await httpRequest(url, async (res, _req, resolve, reject) => {
        try { resolve(await readResponse(res, 1024 * 1024)); } catch (error) { reject(error); }
    });
    assert.equal(value.status, 200);
    return JSON.parse(value.body.toString("utf8"));
}

function collectFor(url, durationMs, maxBytes = MAX_CASE_BYTES, onFirstData) {
    return httpRequest(url, (res, req, resolve, reject) => {
        const chunks = [];
        let bytes = 0;
        let settled = false;
        let gotData = false;
        const finish = error => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            if (error) { reject(error); } else { resolve({ status: res.statusCode, bytes, body: Buffer.concat(chunks) }); }
        };
        const timer = setTimeout(() => { finish(); res.destroy(); }, durationMs);
        res.on("data", chunk => {
            if (!gotData) {
                gotData = true;
                onFirstData?.();
            }
            bytes += chunk.length;
            if (bytes > maxBytes) {
                // This is a bounded observation, not a recording.  The
                // prefix is sufficient for media probing and keeps the live
                // validation from becoming an unbounded memory consumer.
                const accepted = chunk.subarray(0, Math.max(0, maxBytes - (bytes - chunk.length)));
                if (accepted.length) { chunks.push(accepted); }
                bytes = maxBytes;
                finish();
                res.destroy();
                return;
            }
            chunks.push(chunk);
        });
        res.once("end", () => finish());
        res.once("aborted", () => finish(new Error("stream response aborted before capture completed")));
        res.once("error", error => finish(error));
    });
}

function cancelAfterFirstByte(url) {
    return httpRequest(url, (res, req, resolve, reject) => {
        let bytes = 0;
        const timer = setTimeout(() => { req.destroy(); reject(new Error("client cancellation received no data")); }, 30000);
        res.on("data", chunk => {
            bytes += chunk.length;
            clearTimeout(timer);
            req.destroy();
            resolve({ status: res.statusCode, bytes });
        });
        res.once("error", reject);
    });
}

async function waitFor(fn, label, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const result = fn();
        if (result) { return result; }
        await delay(25);
    }
    throw new Error(`timed out waiting for ${label}`);
}

function decoderProcess(filter) {
    let value = filter?._innerFilter;
    const seen = new Set();
    while (value && !seen.has(value)) {
        seen.add(value);
        if (value._process) { return value._process; }
        value = value._output;
    }
    return null;
}

function runPipe(command, input, maxOutput = MAX_CASE_BYTES) {
    return new Promise((resolve, reject) => {
        const child = childProcess.spawn(command[0], command.slice(1));
        const out = [], err = [];
        let outLen = 0, errLen = 0, stdinError;
        child.stdout.on("data", chunk => {
            outLen += chunk.length;
            if (outLen > maxOutput) { child.kill("SIGKILL"); return; }
            out.push(chunk);
        });
        child.stderr.on("data", chunk => {
            if (errLen < STDERR_LIMIT) { err.push(chunk.subarray(0, STDERR_LIMIT - errLen)); errLen += chunk.length; }
        });
        child.once("error", reject);
        child.stdin.once("error", error => {
            // ffmpeg may finish the requested frames before its input
            // writer has flushed the bounded capture. EPIPE is expected when
            // that process itself exits successfully; close() decides it.
            stdinError = error;
        });
        child.once("close", (code, signal) => {
            if (code !== 0 || signal || (stdinError && stdinError.code !== "EPIPE")) {
                reject(new Error(`${command[0]} failed code=${code} signal=${signal}: ${Buffer.concat(err).toString()}`)); return;
            }
            resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8"), stderrTruncated: errLen >= STDERR_LIMIT });
        });
        child.stdin.end(input);
    });
}

async function validateMedia(ts) {
    const ffprobe = await runPipe(["ffprobe", "-v", "error", "-show_entries", "stream=codec_name,codec_type,width,height", "-of", "json", "-i", "pipe:0"], ts, 1024 * 1024);
    const streams = JSON.parse(ffprobe.stdout.toString()).streams || [];
    assert(streams.some(s => s.codec_type === "video" && s.codec_name === "hevc" && s.width === 3840 && s.height === 2160), "missing 3840x2160 HEVC stream");
    assert(streams.some(s => s.codec_type === "audio" && /aac/.test(s.codec_name)), "missing AAC audio stream");
    const framemd5 = await runPipe(["ffmpeg", "-v", "error", "-i", "pipe:0", "-map", "0:v:0", "-frames:v", "120", "-f", "framemd5", "-"], ts, 1024 * 1024);
    const frames = framemd5.stdout.toString().split("\n").filter(line => /^0,/.test(line));
    assert(frames.length >= 120, "ffmpeg did not decode 120 video frames");
    const uniqueFrames = new Set(frames.map(line => line.split(",").at(-1).trim())).size;
    return { streams, decodedFrames: frames.length, uniqueFrames, diagnostics: [
        { tool: "ffprobe", stderr: redact(ffprobe.stderr), stderrTruncated: ffprobe.stderrTruncated },
        { tool: "ffmpeg", stderr: redact(framemd5.stderr), stderrTruncated: framemd5.stderrTruncated }
    ] };
}

async function main() {
    const statusPath = require.resolve("../lib/Mirakurun/status");
    const status = { streamCount: { tsFilter: 0, decoder: 0 }, errorCount: { decoderRespawn: 0 }, epg: {} };
    require.cache[statusPath] = { id: statusPath, filename: statusPath, loaded: true, exports: { __esModule: true, default: status } };
    const log = require("../lib/Mirakurun/log");
    log.logLevel = 1;
    const _ = require("../lib/Mirakurun/_").default;
    const Event = require("../lib/Mirakurun/Event").default;
    const { Tuner } = require("../lib/Mirakurun/Tuner");
    const { Channel } = require("../lib/Mirakurun/Channel");
    const Service = require("../lib/Mirakurun/Service").default;
    const ServiceItem = require("../lib/Mirakurun/ServiceItem").default;
    const { Server } = require("../lib/Mirakurun/Server");
    const { getProgramItemId } = require("../lib/Mirakurun/Program");

    const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, encoding, callback) => {
        if (typeof encoding === "function") { callback = encoding; encoding = undefined; }
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
        const remaining = STDERR_LIMIT - retainedStderrBytes;
        if (remaining > 0) {
            const retained = value.subarray(0, remaining);
            retainedStderr.push(retained);
            retainedStderrBytes += retained.length;
            return originalStderrWrite(redact(retained), callback);
        }
        if (typeof callback === "function") { callback(); }
        return true;
    };
    for (const name of Object.keys(originalConsole)) {
        console[name] = (...args) => originalConsole[name](...args.map(redact));
    }
    // TunerDevice logs its configured command. Keep the secret out of that
    // command and let the small shell wrapper expand only the named env var.
    const commandBS4K = `/bin/sh -c 'exec "$1" "$2" "$${options.secretEnv}" "$3" "$4"' sh ${quote(options.hiraku)} ${quote(options.host)} ${quote(options.mode)} <channel>`;
    _.config = {
        server: { port: 0, hostname: "localhost", disableIPv6: true, disableWebUI: true, disableEITParsing: true,
            allowIPv4CidrRanges: ["127.0.0.0/8"], allowIPv6CidrRanges: [], allowOrigins: [], defaultTlvStreamFormat: "ts",
            tlvStreamProtection: { maxBufferBytes: MAX_CASE_BYTES, startupTimeoutMs: 10000,
                sourceTimeoutMs: 30000, stallTimeoutMs: 15000, outputTimeoutMs: 30000, drainTimeoutMs: 10000 } },
        channels: [{ name: "Hiraku live validation", type: "BS4K", channel: options.channel }],
        tuners: [{ name: "Hiraku live validation", types: ["BS4K"], commandBS4K, tlvToTsDecoder: options.converter }]
    };
    _.configIntegrity = { channels: "verify-tlv-live" };
    _.event = new Event();
    _.job = { add() {}, addSchedule() {} };
    // Channel configuration filters disabled entries through Tuner, so the
    // real tuner owner must exist before constructing Channel.
    _.tuner = new Tuner();
    const programId = getProgramItemId(options.networkId, options.serviceId, 1);
    _.program = { history: { flush: async () => {} }, get: id => id === programId ? {
        id, networkId: options.networkId, serviceId: options.serviceId, eventId: 1, startAt: Date.now(), duration: 1
    } : null };
    _.channel = new Channel(); _.channel.save = () => {};
    const channel = _.channel.get("BS4K", options.channel);
    channel.setStream(0, options.streamId, options.networkId, true);
    channel.addServiceId(options.serviceId, 0);
    _.service = new Service(); _.service.save = () => {};
    _.service.add(new ServiceItem(channel, options.networkId, options.serviceId, "Hiraku live validation", 1, -1, -1, false, 0, options.streamId));
    const filters = new Set();
    const observedFailures = [];
    const lifecycle = [];
    const note = (event, extra = {}) => lifecycle.push({ at: Date.now(), event, ...extra });
    const describeLiveState = () => ({
        lifecycle,
        filters: [...filters].map(filter => ({ closed: filter.closed, detectedFormat: filter.detectedFormat,
            innerClosed: filter._innerFilter?.closed, streamError: filter.streamError?.message })),
        devices: (_.tuner?._devices || []).map(device => ({ pid: device.pid, isUsing: device.isUsing,
            isFree: device.isFree, users: device.users.length }))
    });
    liveDiagnostics = describeLiveState;
    const initServiceStream = _.tuner.initServiceStream.bind(_.tuner);
    _.tuner.initServiceStream = (...args) => initServiceStream(...args).then(filter => {
        filters.add(filter);
        note("filter-created", { filters: filters.size });
        filter.once("failure", error => { observedFailures.push(error); note("filter-failure", { message: error.message }); });
        filter.once("close", () => { filters.delete(filter); note("filter-close", { filters: filters.size }); });
        return filter;
    });
    const server = new Server(); server.testMode = true; _.server = server;
    const results = [];
    const caseStart = name => { print({ event: "case-start", case: name, at: Date.now() }); };
    const cleanupDone = name => { print({ event: "case-cleanup", case: name, state: describeLiveState() }); };
    try {
        await server.init();
        const port = [...server.servers][0].address().port;
        const url = `http://127.0.0.1:${port}/api/services/${options.networkId}${String(options.serviceId).padStart(5, "0")}/stream?decode=1&format=ts`;
        const failuresURL = `http://127.0.0.1:${port}/api/stream-failures`;
        const failureCount = async () => (await getJSON(failuresURL)).length;
        print({ event: "started", host: options.host, mode: options.mode, channel: options.channel, seconds: options.seconds });

        const failuresBeforeNormal = await failureCount();
        let firstNormalData;
        const firstNormalDataPromise = new Promise(resolve => firstNormalData = resolve);
        caseStart("normal");
        const normalPromise = collectFor(url, options.seconds * 1000, MAX_CASE_BYTES, firstNormalData);
        await Promise.race([
            firstNormalDataPromise,
            normalPromise.then(() => { throw new Error("normal stream ended before first payload"); })
        ]);
        await delay(500);
        const tunerSnapshot = await getJSON(`http://127.0.0.1:${port}/api/tuners`);
        const normal = await normalPromise;
        assert.equal(normal.status, 200);
        assert(normal.bytes > 0, "normal request returned no bytes");
        const media = await validateMedia(normal.body);
        const streamInfo = tunerSnapshot.find(tuner => tuner.name === "Hiraku live validation")?.users
            ?.flatMap(user => Object.values(user.streamInfo || {})) || [];
        const mmtpMeasurements = streamInfo.map(entry => entry.measurement).filter(Boolean);
        assert(mmtpMeasurements.length > 0, "live tuner exposed no TLV stream-quality measurements");
        results.push({ case: "normal", status: normal.status, bytes: normal.bytes, media,
            mmtpMeasurements }); print(results.at(-1));
        try {
            await waitFor(() => filters.size === 0, "bounded normal capture cleanup", 5000);
            cleanupDone("normal");
        } catch (error) {
            error.message += `; live state=${JSON.stringify(describeLiveState())}`;
            throw error;
        }
        assert.equal(await failureCount(), failuresBeforeNormal, "normal stream created a failure record");

        // End this request's actual StreamFilter input after first payload.
        // Hiraku itself intentionally respawns while it still has users, so
        // this verifies decoder stdin EOF and stdout drain without treating a
        // tuner-source restart as a clean HTTP source EOF.
        caseStart("filter-input-eof");
        const filterEOF = await httpRequest(url, (res, _req, resolve, reject) => {
            let bytes = 0, ended = false;
            const timer = setTimeout(() => reject(new Error("filter input EOF case timed out")), 30000);
            res.on("data", chunk => {
                bytes += chunk.length;
                if (!ended) {
                    ended = true;
                    const filter = [...filters][0];
                    if (!filter) { reject(new Error("filter vanished before input EOF")); return; }
                    filter.end();
                }
            });
            res.once("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, bytes }); });
            res.once("aborted", () => { clearTimeout(timer); reject(new Error("filter input EOF aborted HTTP response")); });
            res.once("error", error => { clearTimeout(timer); reject(error); });
        });
        assert.equal(filterEOF.status, 200); assert(filterEOF.bytes > 0);
        await waitFor(() => filters.size === 0, "filter input EOF cleanup");
        cleanupDone("filter-input-eof");
        results.push({ case: "filter-input-eof", ...filterEOF }); print(results.at(-1));

        caseStart("client-cancel");
        const failuresBeforeCancel = await failureCount();
        const cancelled = await cancelAfterFirstByte(url);
        assert.equal(cancelled.status, 200); assert(cancelled.bytes > 0);
        await waitFor(() => filters.size === 0, "client cancellation cleanup");
        cleanupDone("client-cancel");
        assert.equal(await failureCount(), failuresBeforeCancel, "client cancellation created a failure record");
        results.push({ case: "client-cancel", ...cancelled, filters: filters.size }); print(results.at(-1));

        caseStart("reconnect");
        const reconnectA = await collectFor(url, 3000, 8 * 1024 * 1024);
        await waitFor(() => filters.size === 0, "first reconnect cleanup");
        const reconnectB = await collectFor(url, 3000, 8 * 1024 * 1024);
        await waitFor(() => filters.size === 0, "second reconnect cleanup");
        assert.equal(reconnectA.status, 200); assert.equal(reconnectB.status, 200);
        assert(reconnectA.bytes > 0 && reconnectB.bytes > 0);
        results.push({ case: "reconnect", firstBytes: reconnectA.bytes, secondBytes: reconnectB.bytes }); print(results.at(-1));

        caseStart("converter-kill-before-first-byte");
        const killBeforeRequest = openRequest(url);
        const beforeFilter = await waitFor(() => [...filters].find(f => decoderProcess(f)), "converter before first payload");
        // This executes before the local HTTP response callback; failure must
        // therefore be a complete 503 JSON response, never a hollow 200.
        decoderProcess(beforeFilter).kill("SIGKILL");
        const { res: beforeResponse } = await killBeforeRequest.response;
        const before = await readResponse(beforeResponse);
        assert.equal(before.status, 503);
        assert.equal(before.aborted, false);
        assert.deepEqual(JSON.parse(before.body.toString("utf8")), { code: 503, reason: "Stream Decoder Failed", errors: [] });
        await waitFor(() => filters.size === 0, "pre-byte kill cleanup");
        const beforeFailures = await getJSON(failuresURL);
        const beforeFailure = beforeFailures.find(value => value.code === "DECODER_EXIT" && value.stage === "conversion");
        assert(beforeFailure, "converter kill did not create a conversion failure record");
        for (const key of ["id", "at", "channel", "stage", "code", "reason", "inputBytes", "outputBytes", "stderr"]) {
            assert(Object.hasOwn(beforeFailure, key), `failure record missing ${key}`);
        }
        assert(!JSON.stringify(beforeFailure).includes(secret), "failure record exposed Hiraku secret");
        results.push({ case: "converter-kill-before-first-byte", status: before.status, bytes: before.bytes,
            aborted: before.aborted, failure: beforeFailure }); print(results.at(-1));

        caseStart("converter-kill-during-stream");
        const killDuringRequest = openRequest(url);
        const { res: duringResponse } = await killDuringRequest.response;
        const firstPayload = once(duringResponse, "data");
        const duringFilter = await waitFor(() => [...filters].find(f => decoderProcess(f)), "converter during payload");
        await firstPayload;
        decoderProcess(duringFilter).kill("SIGKILL");
        const during = await readResponse(duringResponse);
        assert.equal(during.status, 200); assert.equal(during.aborted, true, "converter kill left a complete HTTP 200 response");
        results.push({ case: "converter-kill-during-stream", status: during.status, bytes: during.bytes,
            aborted: during.aborted }); print(results.at(-1));
        await waitFor(() => filters.size === 0, "mid-stream kill cleanup");

        // Keep one response paused while another request must still receive payload.
        caseStart("slow-and-fast");
        _.config.server.tlvStreamProtection = { ..._.config.server.tlvStreamProtection,
            maxBufferBytes: 2 * 1024 * 1024, outputTimeoutMs: 1500 };
        const failuresBeforeSlow = await failureCount();
        const observedFailuresBeforeSlow = observedFailures.length;
        let slowResponse;
        let slowStartedResolve;
        const slowStarted = new Promise(resolve => slowStartedResolve = resolve);
        const slow = new Promise((resolve, reject) => {
            const req = http.get(url, res => {
                slowResponse = res;
                res.once("data", () => { res.pause(); slowStartedResolve(); });
                res.once("aborted", () => resolve({ aborted: true }));
                res.once("end", () => resolve({ aborted: false, ended: true }));
                res.once("error", reject);
            });
            req.once("error", reject);
        });
        await slowStarted;
        const fast = await collectFor(url, 4000, 8 * 1024 * 1024);
        const observedSlowFailure = await waitFor(() => observedFailures.slice(observedFailuresBeforeSlow).at(-1), "slow consumer failure", 7000);
        slowResponse.resume();
        const slowResult = await Promise.race([slow, delay(3000).then(() => { throw new Error("slow consumer connection did not close after server failure"); })]);
        assert.equal(fast.status, 200); assert(fast.bytes > 0, "fast client stalled beside slow client");
        const slowFailures = await getJSON(failuresURL);
        const slowFailure = slowFailures.slice(0, slowFailures.length - failuresBeforeSlow).find(value =>
            value.code === "OUTPUT_STALLED" || value.code === "BUFFER_LIMIT");
        assert(slowFailure, "slow consumer did not record OUTPUT_STALLED or BUFFER_LIMIT");
        assert.equal(observedSlowFailure.detail?.code, slowFailure.code, "slow filter failure and API record disagree");
        assert.equal(slowResult.aborted, true, "slow response completed as a successful HTTP stream");
        results.push({ case: "slow-and-fast", fastStatus: fast.status, fastBytes: fast.bytes,
            slow: slowResult, failure: slowFailure, capBytes: 2 * 1024 * 1024 }); print(results.at(-1));
        await waitFor(() => filters.size === 0, "slow client cleanup");

        assert.equal(status.streamCount.decoder, 0, "decoder count leaked");
        assert.equal(status.streamCount.tsFilter, 0, "filter count leaked");
        print({ event: "passed", cases: results, resourceCounts: status.streamCount });
    } finally {
        for (const filter of filters) { filter.close(); }
        for (const listener of server.servers) { listener.closeAllConnections(); }
        await server.deinit();
        for (const device of _.tuner?._devices || []) {
            if (device.pid !== null) { await device.kill().catch(() => {}); }
        }
        for (const name of Object.keys(originalConsole)) { console[name] = originalConsole[name]; }
        process.stderr.write = originalStderrWrite;
    }
}

main().catch(error => {
    print({ event: "failed", error: redact(error.stack || error.message || error),
        stderr: redact(Buffer.concat(retainedStderr).toString()), stderrTruncated: retainedStderrBytes === STDERR_LIMIT,
        liveState: liveDiagnostics() });
    process.exitCode = 1;
});
