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

test("BS4K EPG jobs serialize before reserving tuners", async t => {
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
    await value._epgGatherer();

    const first = await jobs[0].readyFn();
    assert.equal(first, true);
    let secondFinished = false;
    const secondPromise = jobs[1].readyFn().then(result => {
        secondFinished = true;
        return result;
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(secondFinished, false);

    let finishFirst;
    const ac = new AbortController();
    _.tuner.getEPG = (channel, time, signal) => {
        assert.equal(signal, ac.signal);
        return new Promise(resolve => { finishFirst = resolve; });
    };
    const firstRun = jobs[0].fn({ signal: ac.signal });
    ac.abort();
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(secondFinished, false, "abort must retain ownership until stream cleanup finishes");
    finishFirst();
    await firstRun;
    assert.equal(await secondPromise, true);
    _.tuner.getEPG = async () => undefined;
    await jobs[1].fn({ signal: new AbortController().signal });
});

test("aborting EPG closes its active filter and releases the request", async () => {
    const { EventEmitter } = require("node:events");
    const Tuner = require("../lib/Mirakurun/Tuner").default;
    const tuner = Object.create(Tuner.prototype);
    const filter = new EventEmitter();
    let closed = 0;
    filter.close = () => { closed++; filter.emit("close"); };
    tuner._initTS = async () => filter;
    const ac = new AbortController();
    const pending = tuner.getEPG({ getServices: () => [{ networkId: 11 }] }, 60000, ac.signal);
    await Promise.resolve();
    ac.abort();
    await pending;
    assert.equal(closed, 1);
});

test("EPG completes when its filter closed before startup returned", async () => {
    const Tuner = require("../lib/Mirakurun/Tuner").default;
    const tuner = Object.create(Tuner.prototype);
    tuner._initTS = async () => ({ closed: true });
    await tuner.getEPG({ getServices: () => [{ networkId: 11 }] }, 100);
});
