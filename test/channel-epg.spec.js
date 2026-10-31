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

test("scheduled EPG retains its network when same-number routes contain services from different regions", async t => {
    const previous = { job: _.job, service: _.service, tuner: _.tuner, server: _.config.server };
    t.after(() => {
        _.job = previous.job; _.service = previous.service; _.tuner = previous.tuner; _.config.server = previous.server;
    });
    _.config.server = {};
    const Tuner = require("../lib/Mirakurun/Tuner").default;
    const jobs = [], acquired = [];
    const channel = { type: "GR-ALT", channel: "26", getServices: () => _.service.items };
    _.service = { items: [
        { networkId: 32086, id: 3208643056, channel, epgReady: false },
        { networkId: 32737, id: 3273701032, channel, epgReady: false }
    ], findByNetworkId: id => _.service.items.filter(service => service.networkId === id) };
    _.job = { add: job => jobs.push(job) };
    _.tuner = Object.create(Tuner.prototype);
    _.tuner._initTS = async user => { acquired.push(user.streamSetting.networkId); return null; };
    const channels = Object.create(Channel.prototype);
    channels._startup = false;
    await channels._epgGatherer();
    for (const job of jobs) { await job.fn({ signal: new AbortController().signal }); }
    assert.deepEqual(acquired, [32086, 32737]);
    await assert.rejects(_.tuner.getEPG(channel), /requires a target network/);
});

test("remote EPG skips empty or mismatched sources once each and only publishes the requested network", async t => {
    const previous = { program: _.program, service: _.service };
    t.after(() => Object.assign(_, previous));
    const Tuner = require("../lib/Mirakurun/Tuner").default;
    const tuner = Object.create(Tuner.prototype);
    const data = { id: 327370103205220, networkId: 32737, serviceId: 1032, eventId: 5220,
        startAt: 1793350800000, duration: 1440000, isFree: true };
    const calls = [], publications = [];
    const receiver = (host, response) => ({ isRemote: true, config: { remoteMirakurunHost: host },
        getRemotePrograms: async query => { calls.push([host, query.networkId]); return response; } });
    const empty = receiver("empty-source", []);
    const wrong = receiver("wrong-network", [{ ...data, networkId: 32086 }]);
    const invalid = receiver("invalid-source", [{ ...data, duration: -1 }]);
    const good = receiver("good-source", [data]);
    const service = { epgReady: false };
    _.service = { findByNetworkId: () => [service] };
    _.program = { findByNetworkIdAndReplace: (...args) => publications.push(args) };
    const user = { streamSetting: { networkId: 32737, parseEIT: true } };
    await assert.rejects(tuner._useRemoteData(user, [empty, empty, wrong, invalid]), /No valid remote EPG for network 32737/);
    assert.deepEqual(publications, []);
    assert.equal(service.epgReady, false);
    assert.deepEqual(calls, [["empty-source", 32737], ["wrong-network", 32737], ["invalid-source", 32737]]);
    calls.length = 0;
    assert.equal(await tuner._useRemoteData(user, [empty, good]), true);
    assert.deepEqual(publications, [[32737, [data]]]);
    assert.equal(service.epgReady, true);
});
