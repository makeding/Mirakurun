const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseGGuideReception, dueGGuideReception, mergeGGuideReception } = require("../lib/Mirakurun/GGuideReception");
const source = { channelType: "GR-ALT", channel: "22", serviceId: 2199 };
const request = { channelType: source.channelType, channel: source.channel, durationSeconds: 1800 };
const at = time => Date.parse(`2026-10-24T${time}+09:00`);
// Retained TBS HIP 0152 payload, no key or firmware dependency.
const raw = Buffer.from("7fe304185918000028003c2800782800b42800f028012c2801682801a42801e028021c2802582802942802d028030c2803482803842803c02803fc2884382804742804b02804ec28052828056428", "hex");
const definition = parseGGuideReception(0x85, Buffer.from("0152", "hex"), raw)[0];
const plan = { ...definition, ...source, receivedAt: at("02:00:00") };
const receipt = (slot, completed = false) => ({ ...source, phase: slot.phase, cycle: slot.cycle,
    windowStart: slot.startAt, attemptedAt: slot.startAt, ...(completed ? { completedAt: slot.startAt + 1800000 } : {}) });

test("Panasonic HIP three-byte schedules preserve UTC minutes, preferred bit and complete hourly alternatives", () => {
    assert.equal(definition.windows.length, 24);
    assert.deepEqual(definition.windows.filter(w => w.preferred), [{ preferred: true, day: 0, startMinute: 1080, durationMinutes: 40 }]);
    assert.deepEqual(definition.windows[1], { preferred: false, day: 0, startMinute: 60, durationMinutes: 40 });
    assert.equal(parseGGuideReception(0x75, Buffer.from("0052", "hex"), raw).length, 1);
    for (const [type, meta, bytes] of [[0x56, "0152", raw], [0x85, "0075", raw], [0x85, "0152", raw.subarray(0, -1)],
        [0x85, "0152", Buffer.alloc(6)], [0x85, "0152", Buffer.from([0, 0, 0, 0, 0x59, 1, 0x7, 0xff, 40])],
        [0x85, "0152", Buffer.from([0, 0, 0, 0, 0x59, 1, 0, 0, 0])]]) {
        assert.deepEqual(parseGGuideReception(type, Buffer.from(meta, "hex"), bytes), []);
    }
});

test("03:00 JST preferred window completes once; failed/missed windows recover without minute-by-minute retries", () => {
    const first = dueGGuideReception(request, [plan], [], at("03:01:00"));
    assert.equal(first.startAt, at("03:00:00"));
    assert.equal(first.endAt, at("03:40:00"));
    assert.equal(first.request.durationSeconds, 1800);
    assert.equal(dueGGuideReception(request, [plan], [receipt(first)], at("03:15:00")), undefined);
    const backup = dueGGuideReception(request, [plan], [receipt(first)], at("04:00:00"));
    assert.equal(backup.startAt, at("04:00:00"));
    assert.equal(backup.cycle, first.cycle);
    const done = receipt(backup, true);
    assert.equal(dueGGuideReception(request, [plan], [done], at("05:00:00")), undefined);
    assert.equal(dueGGuideReception(request, [plan], [done], at("02:00:00") + 86400000), undefined);
    assert.equal(dueGGuideReception(request, [plan], [done], at("03:00:00") + 86400000).startAt, at("03:00:00") + 86400000);
    const missed = dueGGuideReception(request, [plan], [], at("23:39:55"));
    assert.equal(missed.request.durationSeconds, 5);
    assert.equal(dueGGuideReception(request, [plan], [], at("23:40:00")), undefined);
});

test("03:40 phases remain independent; selector and duration updates do not reopen a completed phase", () => {
    const extra = { ...plan, id: "extra", windows: definition.windows.map(w => ({ ...w, startMinute: w.startMinute + 40, durationMinutes: 20 })) };
    const first = dueGGuideReception(request, [plan, extra], [], at("03:00:00"));
    const later = dueGGuideReception(request, [plan, extra], [receipt(first, true)], at("03:40:00"));
    assert.equal(later.endAt, at("04:00:00"));
    assert.equal(later.request.durationSeconds, 1200);
    assert.notEqual(first.phase, later.phase);
    const updated = { ...extra, id: "other-selector", windows: extra.windows.map(w => ({ ...w, durationMinutes: 17 })) };
    assert.equal(dueGGuideReception(request, [extra, updated], [receipt(later, true)], at("04:40:00")), undefined);
    const late = dueGGuideReception(request, [extra], [], at("03:59:58"));
    assert.equal(late.request.durationSeconds, 2);
});

test("discovery is bounded across restarts, tolerates old missing metadata, and expires old plans/progress", () => {
    const slot = dueGGuideReception(request, [], [], at("12:00:00"));
    assert.equal(slot.phase, "discovery");
    const failed = receipt(slot);
    assert.equal(dueGGuideReception(request, [], [failed], at("12:30:00")), undefined);
    assert.ok(dueGGuideReception(request, [], [failed], at("13:00:00")));
    const saved = mergeGGuideReception({}, { receptionPlans: [plan], receptionProgress: [receipt(slot, true)] }, 0);
    const restored = JSON.parse(JSON.stringify(saved));
    assert.equal(dueGGuideReception(request, [], restored.receptionProgress, at("17:59:00")), undefined);
    assert.ok(dueGGuideReception(request, [], restored.receptionProgress, at("18:00:00")));
    assert.equal(mergeGGuideReception(restored, {}, at("18:00:00")).receptionPlans.length, 0);
    assert.deepEqual(mergeGGuideReception({}, {}, 0), { receptionPlans: [], receptionProgress: [] });
    const unverifiedWeekday = { ...plan, windows: plan.windows.map(w => ({ ...w, day: 1 })) };
    assert.equal(dueGGuideReception(request, [unverifiedWeekday], [], at("03:00:00")).phase, "discovery");
});
