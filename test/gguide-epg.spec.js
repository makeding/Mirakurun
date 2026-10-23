const assert = require("node:assert/strict");
const { test } = require("node:test");
const { enrichGGuideEpg } = require("../lib/Mirakurun/GGuideEpg");

const association = { programGgid: "e1040000abd4", networkId: 32722, serviceId: 2064,
    startAt: 1793008800000, duration: 6900000, name: "GGuide title" };
const assets = [{ id: "image", programs: [association] }, { id: "advert", programs: [] }];
const program = { id: 327220206400123, eventId: 123, networkId: 32722, serviceId: 2064,
    startAt: association.startAt, duration: association.duration, isFree: true, name: "EPG title",
    description: "番組のあらすじ", extended: { 出演者: "出演者一覧" },
    genres: [{ lv1: 1, lv2: 2, un1: 0, un2: 0 }],
    relatedItems: [{ networkId: 32722, serviceId: 2064, eventId: 124, type: "relay" }] };

test("HGuide exposes the complete matched EPG, actual IDs and summary without copying internal flags", () => {
    const result = enrichGGuideEpg(assets, [{ ...program, _pf: true }]);
    assert.deepEqual(result[0].programs[0], { ...association, programId: program.id, eventId: program.eventId,
        description: program.description, extended: program.extended, program });
    assert.deepEqual(result[1], assets[1]);
    assert.equal(association.programId, undefined);
    const updated = { ...program, description: "更新された概要", extended: { 内容: "最新情報" } };
    assert.deepEqual(enrichGGuideEpg(assets, [updated])[0].programs[0].program, updated);
});

test("HGuide never invents EPG IDs for missing, shifted, wrong-region or ambiguous schedules", () => {
    for (const events of [[], [{ ...program, networkId: 1 }], [{ ...program, serviceId: 1 }],
        [{ ...program, startAt: program.startAt + 60000 }], [{ ...program, duration: 60000 }],
        [program, { ...program, id: program.id + 1, eventId: 124 }]]) {
        assert.deepEqual(enrichGGuideEpg(assets, events), assets);
    }
    const { startAt, ...withoutTime } = association;
    assert.equal(enrichGGuideEpg([{ programs: [withoutTime] }], [program])[0].programs[0].programId, undefined);
    const { duration, ...withoutDuration } = association;
    assert.equal(enrichGGuideEpg([{ programs: [withoutDuration] }], [program])[0].programs[0].programId, program.id);
    const { description, extended, ...withoutSummary } = program;
    const result = enrichGGuideEpg(assets, [withoutSummary])[0].programs[0];
    assert.equal(result.description, undefined);
    assert.deepEqual(result.program, withoutSummary);
});
