const assert = require("node:assert/strict");
const { test } = require("node:test");
const _ = require("../lib/Mirakurun/_").default;
const statusPath = require.resolve("../lib/Mirakurun/status");
require.cache[statusPath] = {
    id: statusPath, filename: statusPath, loaded: true,
    exports: { __esModule: true, default: { epg: {} } }
};
const status = require("../lib/Mirakurun/status").default;
const Channel = require("../lib/Mirakurun/Channel").default;

test("BS4K EPG jobs wait when the network is already being gathered", async t => {
    const previous = { job: _.job, service: _.service, tuner: _.tuner, program: _.program, server: _.config.server };
    t.after(() => {
        _.job = previous.job; _.service = previous.service; _.tuner = previous.tuner;
        _.program = previous.program; _.config.server = previous.server;
    });
    const jobs = [];
    _.job = { add: job => jobs.push(job) };
    _.tuner = { readyForJob: () => true, getEPG: async () => undefined };
    _.program = {};
    _.config.server = { disableEITParsing: true };
    const channel = { type: "BS4K", channel: "BS07_2", route: "SAT" };
    _.service = { items: [
        { networkId: 11, id: 1100101, channel, epgReady: false },
        { networkId: 11, id: 1100102, channel, epgReady: false }
    ], findByNetworkId: networkId => _.service.items.filter(item => item.networkId === networkId) };
    const value = Object.create(Channel.prototype);
    value._startup = false;
    status.epg[11] = true;
    await value._epgGatherer();
    assert.equal(jobs.length, 2);
    assert.equal(await jobs[0].readyFn(), false);
    assert.equal(await jobs[1].readyFn(), false);
    delete status.epg[11];
});
