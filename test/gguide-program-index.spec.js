const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseGGuideProgramIndex, resolveGGuidePrograms, mergeGGuideIndex, gguideScope } = require("../lib/Mirakurun/GGuideProgramIndex");
const { parseGGuideProgramSchedule } = require("../lib/Mirakurun/GGuideProgramSchedule");

const source = { channelType: "GR", channel: "16", serviceId: 2199 };
const scope = gguideScope(source);
const frame = bytes => Buffer.concat([Buffer.alloc(4), Buffer.from([bytes.length]), bytes]);
const df = (category, hex) => {
    const metadata = Buffer.alloc(2); metadata.writeUInt16BE(category);
    return parseGGuideProgramIndex(0xdf, metadata, frame(Buffer.from(hex, "hex")));
};
const fact = value => ({ scope, value, receivedAt: 100 });

test("real Panasonic OBJ12/GIDRP bytes resolve MBS without calling a private GGID an EIT event", () => {
    const media = df(1305, "051900a78e8b0118696d6167652f472d47756964652d4f424a31322d4a504547162f4f424a31323a3239362f696d675f3239362e6a706741767d70417dbdb0");
    const program = df(0, "e1040000abd4841000abd4417a71f04184fdef");
    const middle = df(1304, "0518010e6327000000000000000000000000");
    const links = [...df(0x4000, "051900a78e8b0518010e63270000000000000000"),
        ...df(0x4000, "0518010e6327e1040000abd40000000000000000")];
    const channels = parseGGuideProgramIndex(0xf3, Buffer.alloc(0), Buffer.from("088410c07fd2081001", "hex"));
    const facts = [...media, ...program, ...middle, ...links, ...channels].map(fact);
    const assets = [{ id: "image" }, { id: "unrelated" }];
    const binding = { ...source, kind: "obj12", objectId: 296, members: [{ assetId: "image", role: "media" }] };
    const [image, unknown] = resolveGGuidePrograms(assets, [binding], facts);
    assert.deepEqual(image.programs, [{ programGgid: "e1040000abd4", networkId: 32722, serviceId: 2064 }]);
    assert.deepEqual(unknown.programs, []);
    assert.deepEqual(resolveGGuidePrograms(assets, [{ ...binding, channel: "17" }], facts)[0].programs, []);
    const incomplete = facts.filter(item => item.value.kind !== "switch");
    assert.deepEqual(resolveGGuidePrograms(assets, [binding], incomplete)[0].programs, []);
    const series = fact({ kind: "link", id: "series", from: "e1040000abd4", to: "other" });
    const other = fact({ kind: "program", id: "other", gcn: 1 });
    assert.deepEqual(resolveGGuidePrograms(assets, [binding], [...facts, series, other])[0].programs, image.programs);
});

test("index updates merge across modules, prune independently, and bound malformed lengths", () => {
    const value = { kind: "switch", id: "one" };
    assert.deepEqual(mergeGGuideIndex([fact(value)], [{ ...fact(value), receivedAt: 200 }], 150), [{ ...fact(value), receivedAt: 200 }]);
    assert.deepEqual(mergeGGuideIndex([fact(value)], [], 100), []);
    for (const bytes of [[], [255], [255, 255, 0], [8, 1]]) {
        assert.deepEqual(parseGGuideProgramIndex(0xf3, Buffer.alloc(0), Buffer.from(bytes)), []);
    }
});

test("private SI fields agree with Panasonic's transformed event and preserve full private keys", () => {
    // Retained MBS SI, metadata 840831ab0000. The original ARM transform emits
    // 0461 ef98 000000 003000; its private 0x0f descriptor carries 000461.
    const title = Buffer.from("cddbeaf3d1dbeaf32226335835694a783275b7bf1b6f2f6939ce0f40684038fe383d3e6cce1b6f6a226bc80f4038454cce4b5c323b1b243b7a5c7a567a6a7b", "hex");
    const entry = Buffer.alloc(688);
    Buffer.from("000050000004613e", "hex").copy(entry);
    title.copy(entry, 8);
    const boundary = Buffer.from("001e0d00ffffff0000000000000d", "hex");
    const data = Buffer.concat([Buffer.from([255, 255, 178]), entry, Buffer.from([boundary.length]), boundary]);
    const [event] = parseGGuideProgramSchedule(Buffer.from("840831ab0000", "hex"), data);
    assert.equal(event.programKey, "000461");
    assert.equal(event.name, "ねほりんぱほりん▽学級崩壊したクラスの先生・現場のリアルと生徒の本音🈖🈑🈞");
    assert.equal(event.startAt, Date.parse("2026-10-22T15:00:00Z"));
    assert.equal(event.duration, 30 * 60000);
    assert.equal(parseGGuideProgramSchedule(Buffer.from("840831ab0000", "hex"), data).length, 1);
    assert.deepEqual(parseGGuideProgramSchedule(Buffer.alloc(0), data), []);
    assert.deepEqual(parseGGuideProgramSchedule(Buffer.from("840831ab", "hex"), data.subarray(0, -1)), []);

    const overnight = Buffer.from("fffe500000046100", "hex");
    const atMidnight = Buffer.from("00000d00ffffff00", "hex");
    const [previousDay] = parseGGuideProgramSchedule(Buffer.from("840831ac", "hex"),
        Buffer.concat([Buffer.from([8]), overnight, Buffer.from([8]), atMidnight]));
    assert.equal(previousDay.startAt, Date.parse("2026-10-23T14:58:00Z"));
    assert.equal(previousDay.duration, 2 * 60000);
    const [noBoundary] = parseGGuideProgramSchedule(Buffer.from("840831ac", "hex"), Buffer.concat([Buffer.from([8]), overnight]));
    assert.equal(noBoundary.duration, undefined);
    assert.equal(previousDay.id, noBoundary.id);
    assert.equal(mergeGGuideIndex([fact({ kind: "schedule", ...previousDay })],
        [{ ...fact({ kind: "schedule", ...noBoundary, startAt: noBoundary.startAt + 60000 }), receivedAt: 200 }], 0).length, 1);
});

test("SI enriches only the exact GCN and private DF program key, including after a separate index merge", () => {
    const media = df(1305, "051900a78e8b0118696d6167652f472d47756964652d4f424a31322d4a504547162f4f424a31323a3239362f696d675f3239362e6a706741767d70417dbdb0");
    const values = [...media, ...df(0, "e1040000abd4841000abd4417a71f04184fdef"),
        ...df(1304, "0518010e6327000000000000000000000000"),
        ...df(0x4000, "051900a78e8b0518010e63270000000000000000"),
        ...df(0x4000, "0518010e6327e1040000abd40000000000000000"),
        ...parseGGuideProgramIndex(0xf3, Buffer.alloc(0), Buffer.from("088410c07fd2081001", "hex"))];
    const event = { kind: "schedule", id: "exact", gcn: 0x8410, programKey: "00abd4", name: "番組", startAt: 123, duration: 456 };
    const assets = [{ id: "image" }];
    const bindings = [{ ...source, kind: "obj12", objectId: 296, members: [{ assetId: "image", role: "media" }] }];
    const facts = mergeGGuideIndex(values.map(fact), [fact(event)], 0);
    const [program] = resolveGGuidePrograms(assets, bindings, facts)[0].programs;
    assert.deepEqual(program, { programGgid: "e1040000abd4", networkId: 32722, serviceId: 2064, name: "番組", startAt: 123, duration: 456 });
    for (const mismatch of [{ ...event, gcn: 0x8411 }, { ...event, programKey: "80abd4" }]) {
        assert.equal(resolveGGuidePrograms(assets, bindings, [...values, mismatch].map(fact))[0].programs[0].name, undefined);
    }
});
