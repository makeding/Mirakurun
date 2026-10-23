const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseGGuideProgramIndex, resolveGGuidePrograms, mergeGGuideIndex, gguideScope } = require("../lib/Mirakurun/GGuideProgramIndex");

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
