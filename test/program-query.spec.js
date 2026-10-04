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
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { ProgramHistory } = require("../lib/Mirakurun/ProgramHistory");

const DAY = 86400000;

function program(id, serviceId = 1, name = `番組 ${id}`) {
    return {
        id,
        networkId: 1,
        serviceId,
        eventId: id,
        startAt: 1700000000000 + id * 60000,
        duration: 30000,
        isFree: true,
        name,
        description: `${name} の説明`,
        extended: { 内容: "日本語の番組情報" }
    };
}

async function history(t) {
    const store = new ProgramHistory({
        path: ":memory:",
        integrity: "program-query-test",
        retentionDays: 3650
    });
    t.after(() => store.close());
    await store.open();
    return store;
}

async function programs(store, query = {}) {
    return JSON.parse(await store.programs(query));
}

function observe(store, data, status = "active") {
    store.record({ program: data, status, observedAt: data.startAt - DAY });
}

describe("[program-query.spec] SQLite current program projection", () => {
    it("orders by durable insertion position, updates in place, and places a re-added program last", async t => {
        const store = await history(t);
        const first = program(1);
        const second = program(2);
        observe(store, first);
        observe(store, second);
        observe(store, { ...first, name: "第一番組・改訂" });
        assert.deepEqual((await programs(store)).map(item => item.name), ["第一番組・改訂", "番組 2"]);

        observe(store, first, "removed");
        assert.deepEqual((await programs(store)).map(item => item.id), [second.id]);

        observe(store, { ...first, name: "第一番組・再開" });
        assert.deepEqual((await programs(store)).map(item => item.name), ["番組 2", "第一番組・再開"]);
    });

    it("filters current records and preserves complete Unicode program JSON", async t => {
        const store = await history(t);
        const japanese = program(11, 1, "深夜ニュース・東京");
        const other = program(12, 2, "スポーツ速報");
        observe(store, japanese);
        observe(store, other);

        assert.deepEqual(await programs(store, { serviceId: 1 }), [japanese]);
        assert.deepEqual(await programs(store, { networkId: 1, serviceId: 2 }), [other]);
        assert.deepEqual(await programs(store, { name: "深夜ニュース・東京" }), [japanese]);
        const sift = require("sift");
        for (const query of [
            { eventId: { $gte: 12 } },
            { $or: [{ serviceId: 2 }, { name: { $regex: "東京" } }] },
            { networkId: 1, "extended.内容": { $exists: true }, startAt: { $lt: other.startAt } },
            { serviceId: { $in: [1, 2] }, name: { $ne: "スポーツ速報" } },
            { networkId: "1" }, { unknown: { $exists: false } }
        ]) {
            assert.deepEqual(await programs(store, query), [japanese, other].filter(sift(query)));
        }
        await assert.rejects(store.programs({ name: { $where: "true" } }), /\$where/);
        await assert.rejects(store.programs({ name: { $unknown: true } }), { status: 400 });
        assert.deepEqual(await programs(store), [japanese, other]);
    });

    it("serves concurrent full and filtered reads after a write batch without partial JSON", async t => {
        const store = await history(t);
        const expected = [];
        for (let id = 1; id <= 48; ++id) {
            const item = program(100 + id, id % 2 + 1, `同時読取 ${id}`);
            expected.push(item);
            observe(store, item);
        }

        const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
            programs(store, index % 2 === 0 ? {} : { serviceId: 1 })));
        for (let index = 0; index < responses.length; ++index) {
            assert.deepEqual(responses[index], index % 2 === 0 ? expected : expected.filter(item => item.serviceId === 1));
        }
    });
});
