/*
   Copyright 2026 huggy
   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at
       http://www.apache.org/licenses/LICENSE-2.0
   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Program } = require("../lib/Mirakurun/Program");
const { ProgramHistory } = require("../lib/Mirakurun/ProgramHistory");
const shared = require("../lib/Mirakurun/_").default;
const Event = require("../lib/Mirakurun/Event").default;

test("service conflict index follows insertion, replacement, recovery, expiry and deletion", async t => {
    shared.event = new Event();
    const store = new Program({ memoryOnly: true });
    const history = new ProgramHistory({ path: ":memory:", integrity: "index-test", retentionDays: 365 });
    await history.open();
    store._history = history;
    t.after(() => store.close());
    const startAt = Date.now() + 3600000;
    const p = (id, networkId = 1, serviceId = 1) => ({ id, networkId, serviceId,
        eventId: id, startAt, duration: 60000, isFree: true, name: `番組 ${id}` });
    const check = async () => {
        const expected = new Map();
        const expectedNetworks = new Map();
        for (const item of store.itemMap.values()) {
            const key = `${item.networkId}:${item.serviceId}`;
            if (!expected.has(key)) { expected.set(key, new Set()); }
            expected.get(key).add(item.id);
            if (!expectedNetworks.has(item.networkId)) { expectedNetworks.set(item.networkId, new Set()); }
            expectedNetworks.get(item.networkId).add(item.id);
        }
        assert.deepEqual(store._networkItems, expectedNetworks);
        const actual = new Map();
        for (const [nid, services] of store._serviceItems) {
            assert.ok(services.size);
            for (const [sid, ids] of services) {
                assert.ok(ids.size);
                actual.set(`${nid}:${sid}`, ids);
            }
        }
        assert.deepEqual(actual, expected);
        for (const [networkId, ids] of expectedNetworks) {
            assert.deepEqual(store.findByNetworkId(networkId).map(item => item.id), [...ids]);
            const serviceIds = new Set(store.findByNetworkId(networkId).map(item => item.serviceId));
            for (const serviceId of serviceIds) {
                const serviceItems = [...store.itemMap.values()]
                    .filter(item => item.networkId === networkId && item.serviceId === serviceId);
                assert.deepEqual(store.findByNetworkIdServiceId(networkId, serviceId), serviceItems);
                for (const time of [startAt + 30000, startAt + 90000]) {
                    assert.deepEqual(store.findByNetworkIdAndServiceIdAndTime(networkId, serviceId, time),
                        serviceItems.filter(item => item.startAt <= time && item.startAt + item.duration > time));
                }
            }
            for (const time of [startAt + 30000, startAt + 90000]) {
                const networkItems = store.findByNetworkId(networkId);
                assert.deepEqual(store.findByNetworkIdAndTime(networkId, time),
                    networkItems.filter(item => item.startAt <= time && item.startAt + item.duration > time));
            }
        }
        assert.deepEqual(JSON.parse(await history.programs({})), [...store.itemMap.values()]);
    };
    store.add(p(1)); store.add(p(2, 1, 2)); store.add(p(3, 2, 1));
    await check();
    store.add(p(4)); // only the same network/service overlaps
    assert.equal(store.get(1), null);
    assert.ok(store.get(2)); assert.ok(store.get(3));
    await check();
    store.set(1, { startAt: startAt + 60000 }); // recover logical deletion
    await check();
    store.findByNetworkIdAndReplace(1, [{ ...p(4), name: "更新" }, { ...p(1), startAt: startAt + 60000 }]);
    await check();
    store.set(1, { serviceId: 9 });
    await check();
    store.set(1, { startAt: 0 }); // expired active record
    await check();
    store.remove(3); store.remove(4);
    await check();
    assert.equal(store._serviceItems.size, 0);
    assert.equal(store._networkItems.size, 0);
});

test("indexed queries and replacement retain global insertion and reverse removal order", t => {
    shared.event = new Event();
    const store = new Program({ memoryOnly: true });
    t.after(() => store.close());
    const startAt = Date.now() + 3600000;
    const p = (id, networkId, serviceId, offset = 0) => ({ id, networkId, serviceId,
        eventId: id, startAt: startAt + offset, duration: 60000, isFree: true, name: `番組 ${id}` });
    store.add(p(1, 2, 9));
    store.add(p(2, 1, 1));
    store.add(p(3, 2, 1, 120000));
    store.add(p(4, 1, 2));
    store.add(p(5, 1, 1, 120000));

    // An identity change mutates the object in-place and must not move it after later items.
    store.set(1, { networkId: 1, serviceId: 1 });
    assert.deepEqual(store.findByNetworkId(1).map(item => item.id), [1, 2, 4, 5]);
    assert.deepEqual(store.findByNetworkIdServiceId(1, 1).map(item => item.id), [1, 2, 5]);
    assert.deepEqual(store.findByNetworkIdAndTime(1, startAt + 30000).map(item => item.id), [1, 2, 4]);
    assert.deepEqual(store.findByNetworkIdAndServiceIdAndTime(1, 1, startAt + 30000).map(item => item.id), [1, 2]);

    const retained = [structuredClone(store.get(1)), structuredClone(store.get(4))];
    store.findByNetworkIdAndReplace(1, retained);
    assert.deepEqual(shared.event.log.filter(message => message.resource === "program" && message.type === "remove")
        .map(message => message.data.id), [5, 2]);
    assert.deepEqual(store.findByNetworkId(1).map(item => item.id), [1, 4]);

    // Remote replacement also preserves the item's Map position when its identity changes.
    store.findByNetworkIdAndReplace(1, [{ ...retained[0], networkId: 3, serviceId: 7 }, retained[1]]);
    assert.deepEqual(store.findByNetworkId(3).map(item => item.id), [1]);
    assert.deepEqual(store.findByNetworkId(1).map(item => item.id), [4]);
    assert.deepEqual([...store.itemMap.keys()], [1, 3, 4]);
});
