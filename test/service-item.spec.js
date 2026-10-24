const { describe, it, beforeEach } = require("node:test");
const assert = require("assert");

const shared = require("../lib/Mirakurun/_").default;
const MirakurunEvent = require("../lib/Mirakurun/Event").default;
const ChannelItem = require("../lib/Mirakurun/ChannelItem").default;
const ServiceItem = require("../lib/Mirakurun/ServiceItem").default;
const Service = require("../lib/Mirakurun/Service").Service;

it("service indexes preserve identity, order, duplicates and mutable logo/channel metadata", () => {
    const previous = { service: shared.service, event: shared.event, channel: shared.channel };
    const services = new Service();
    services.save = () => {};
    shared.service = services;
    shared.event = new MirakurunEvent();
    shared.channel = { findByService: () => [] };
    try {
        const channel = new ChannelItem({ name: "Test", type: "GR", channel: "13" });
        const first = new ServiceItem(channel, 1, 1, "first", 1, 5);
        const other = new ServiceItem(channel, 2, 1, "other", 1, 5);
        const last = new ServiceItem(channel, 1, 2, "last", 1, 6);
        for (const item of [first, other, last, new ServiceItem(channel, 1, 1, "duplicate", 1)]) services.add(item);
        assert.deepStrictEqual(services.items, [first, other, last]);
        assert.strictEqual(services.get(first.id), first);
        assert.strictEqual(services.get(1, 1), first);
        assert.strictEqual(services.get(2, 1), other);
        assert.strictEqual(services.get(999), null);
        assert.strictEqual(services.get(1, 999), null);
        assert.strictEqual(services.exists(1, 2), true);
        assert.deepStrictEqual(services.findByNetworkId(1), [first, last]);
        services.findByNetworkId(1).pop();
        assert.deepStrictEqual(services.findByNetworkId(1), [first, last]);
        first.logoId = 6;
        assert.deepStrictEqual(services.findByNetworkIdWithLogoId(1, 6), [first, last]);
        const next = new ChannelItem({ name: "Next", type: "GR", channel: "14" });
        first.channel = next;
        assert.strictEqual(services.get(first.id).channel, next);
        assert.deepStrictEqual(services.findByChannel(next), [first]);
    } finally { Object.assign(shared, previous); }
});

describe("[service-item.spec] service channel reassignment", () => {
    let saveCount;

    beforeEach(() => {
        saveCount = 0;
        shared.event = new MirakurunEvent();
        shared.service = {
            save: () => {
                saveCount++;
            }
        };
    });

    it("moves a remotely discovered service to the directly scanned local channel", () => {
        const remoteChannel = new ChannelItem({
            name: "ABC remote",
            type: "GR-ALT",
            channel: "15"
        });
        const localChannel = new ChannelItem({
            name: "ABC local",
            type: "GR",
            channel: "15"
        });
        const service = new ServiceItem(remoteChannel, 32723, 2072, "ＡＢＣテレビ１", 1);

        service.channel = localChannel;

        assert.strictEqual(service.channel, localChannel);
        assert.deepStrictEqual(service.export().channel, {
            type: "GR",
            channel: "15"
        });
        assert.strictEqual(saveCount, 1);
    });

    it("does not emit an update when the channel is unchanged", () => {
        const channel = new ChannelItem({
            name: "ABC local",
            type: "GR",
            channel: "15"
        });
        const service = new ServiceItem(channel, 32723, 2072, "ＡＢＣテレビ１", 1);

        service.channel = channel;

        assert.strictEqual(saveCount, 0);
    });
});
