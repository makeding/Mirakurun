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
        for (const item of store.itemMap.values()) {
            const key = `${item.networkId}:${item.serviceId}`;
            if (!expected.has(key)) { expected.set(key, new Set()); }
            expected.get(key).add(item.id);
        }
        const actual = new Map();
        for (const [nid, services] of store._serviceItems) {
            assert.ok(services.size);
            for (const [sid, ids] of services) {
                assert.ok(ids.size);
                actual.set(`${nid}:${sid}`, ids);
            }
        }
        assert.deepEqual(actual, expected);
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
});
