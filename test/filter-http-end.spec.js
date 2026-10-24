const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { PassThrough } = require("node:stream");
const { once } = require("node:events");

test("raw TLV program closes HTTP when the broadcast advances to the next event", { timeout: 3000 }, async t => {
    const context = require("../lib/Mirakurun/_").default;
    context.program = { get: () => ({ startAt: Date.now(), duration: 60000 }) };
    const Filter = require("../lib/Mirakurun/TLVFilter").default;
    const server = http.createServer((req, res) => {
        const output = new PassThrough();
        const filter = new Filter({ output, passthrough: true, networkId: 1, serviceId: 151, eventId: 9225 });
        t.after(() => filter.close());
        filter._eventEndTimeout = 1;
        filter._mptPid = 100;
        output.pipe(res);
        const eit = { currentNextIndicator: true, originalNetworkId: 1,
            tableId: "EIT[p/f]", sectionNumber: 0, serviceId: 151, events: [{ eventId: 9225 }] };
        filter._onEIT(eit);
        output.write(Buffer.from("raw payload"));
        filter._onEIT({ ...eit, events: [{ eventId: 9227 }] });
    });
    t.after(() => { server.closeAllConnections(); server.close(); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const request = http.get(`http://127.0.0.1:${server.address().port}/`);
    t.after(() => request.destroy());
    const [response] = await once(request, "response");
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    assert.equal(response.complete, true);
    assert.equal(Buffer.concat(chunks).toString(), "raw payload");
});

const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = {
    id: statusPath, filename: statusPath, loaded: true,
    exports: { __esModule: true, default: { streamCount: { tsFilter: 0 }, epg: {} } }
};
require("../lib/Mirakurun/_").default.config = { server: {} };

for (const name of ["TSFilter", "TLVFilter"]) {
    const Filter = require(`../lib/Mirakurun/${name}`).default;
    test(`${name} drains staged bytes and ends HTTP without waiting for socket timeout`, { timeout: 3000 }, async t => {
        const expected = Buffer.alloc(128 * 1024, 0x47);
        const server = http.createServer((req, res) => {
            const output = new PassThrough({ highWaterMark: 1024 });
            const filter = new Filter({ output });
            t.after(() => filter.close());
            output.pipe(res);
            output.write(expected);
            filter.close();
        });
        t.after(() => { server.closeAllConnections(); server.close(); });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const request = http.get(`http://127.0.0.1:${server.address().port}/`);
        t.after(() => request.destroy());
        const [response] = await once(request, "response");
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        assert.equal(response.complete, true);
        assert.deepEqual(Buffer.concat(chunks), expected);
    });

    test(`${name} closes only once when the output is destroyed`, async () => {
        const output = new PassThrough();
        const filter = new Filter({ output });
        let closes = 0;
        filter.on("close", () => closes++);
        output.destroy();
        await once(output, "close");
        filter.close();
        assert.equal(closes, 1);
    });
}
