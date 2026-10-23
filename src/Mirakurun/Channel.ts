/*
   Copyright 2016 kanreisa

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
import * as common from "./common";
import * as log from "./log";
import * as apid from "../../api";
import _ from "./_";
import status from "./status";
import ChannelItem, { StreamEntry } from "./ChannelItem";
import * as db from "./db";
import { JobItem } from "./Job";

export function streamFormatOf(isTlv: boolean | undefined): apid.StreamFormat | undefined {
    if (isTlv === undefined) {
        return undefined;
    }
    return isTlv ? "tlv" : "ts";
}

export interface StreamIDIndexItem {
    readonly networkId: number;
    readonly streamId: number;
    /** `undefined` until the stream has been seen once. */
    streamFormat?: apid.StreamFormat;
    readonly channels: Array<{
        channel: ChannelItem;
        entry: StreamEntry;
    }>;
}

export class Channel {
    private _items: ChannelItem[] = [];
    private _startup: boolean = true;
    private _saveTimerId: NodeJS.Timeout;
    private _streamIDIndex = new Map<number, Map<number, StreamIDIndexItem>>();
    private _streamIDIndexDirty = true;

    constructor() {
        this._load();

        if (_.config.server.disableEITParsing !== true) {
            const epgJob: JobItem = {
                key: "EPG.Gatherer",
                name: "EPG Gatherer",
                fn: () => this._epgGatherer()
            };

            _.job.add({
                ...epgJob,
                readyFn: async () => {
                    await common.sleep(1000 * 60);
                    return true;
                }
            });

            _.job.addSchedule({
                key: epgJob.key,
                schedule: _.config.server.epgGatheringJobSchedule || "20,50 * * * *",
                job: epgJob
            });
        }
    }

    get items(): ChannelItem[] {
        return this._items;
    }

    add(item: ChannelItem): void {
        if (this.get(item.type, item.channel, item.route) === null) {
            this._items.push(item);
            this.invalidateStreamIDIndex();
        }
    }

    get(type: apid.ChannelType, channel: string, route?: apid.ChannelRoute): ChannelItem {
        const l = this._items.length;
        for (let i = 0; i < l; i++) {
            if (this._items[i].channel === channel && this._items[i].type === type &&
                (route === undefined || this._items[i].route === route)) {
                return this._items[i];
            }
        }

        return null;
    }

    findByType(type: apid.ChannelType): ChannelItem[] {
        const items = [];

        const l = this._items.length;
        for (let i = 0; i < l; i++) {
            if (this._items[i].type === type) {
                items.push(this._items[i]);
            }
        }

        return items;
    }

    findByStreamId(networkId: number, streamId: number): ChannelItem[] {
        const item = this.getStreamID(networkId, streamId);
        return item ? item.channels.map(value => value.channel) : [];
    }

    getStreamIDs(networkId?: number): StreamIDIndexItem[] {
        this._ensureStreamIDIndex();
        if (networkId !== undefined) {
            const streams = this._streamIDIndex.get(networkId);
            return streams ? [...streams.values()] : [];
        }
        const items: StreamIDIndexItem[] = [];
        for (const streams of this._streamIDIndex.values()) {
            items.push(...streams.values());
        }
        return items;
    }

    getStreamID(networkId: number, streamId: number): StreamIDIndexItem | undefined {
        this._ensureStreamIDIndex();
        return this._streamIDIndex.get(networkId)?.get(streamId);
    }

    invalidateStreamIDIndex(): void {
        this._streamIDIndexDirty = true;
    }

    findByService(networkId: number, serviceId: number): ChannelItem[] {
        return this._items.filter(channel => {
            const entry = channel.getStreamForService(serviceId);
            return entry && entry.networkId === networkId;
        });
    }

    save(): void {
        clearTimeout(this._saveTimerId);
        this._saveTimerId = setTimeout(() => this._save(), 500);
    }

    async load(): Promise<void> {
        log.debug("loading channels db...");

        const records = await db.loadChannels(_.configIntegrity.channels);
        for (const record of records) {
            const channel = this.get(record.type, record.channel, record.route);
            if (!channel) {
                continue;
            }
            if (record.groupId !== undefined && record.groupId !== null) {
                channel.setTsmfGroupId(record.groupId);
            }
            let firstRelTs: number | undefined;
            if (record.streams) {
                for (const entry of record.streams) {
                    let streamKey: number;
                    let relTs: number | undefined;
                    if (entry.relTs !== undefined) {
                        streamKey = entry.relTs;
                        relTs = entry.relTs;
                    } else {
                        streamKey = 0;
                        relTs = undefined;
                    }
                    channel.setStream(streamKey, entry.streamId, entry.networkId, entry.isTlv, relTs);
                    if (entry.serviceIds) {
                        for (const sid of entry.serviceIds) {
                            channel.addServiceId(sid, streamKey);
                        }
                    }
                    if (firstRelTs === undefined && relTs !== undefined) {
                        firstRelTs = relTs;
                    }
                }
            }
            if (firstRelTs !== undefined) {
                channel.setTsmfRelTs(firstRelTs);
            }
        }
        log.info("loaded channels db (%d records)", records.length);
    }

    private _save(): void {
        log.debug("saving channels db...");

        const records: db.ChannelRecord[] = [];
        for (const channel of this._items) {
            const record: db.ChannelRecord = {
                type: channel.type,
                channel: channel.channel,
                route: channel.route
            };
            let hasData = false;

            if (common.isValidTsmfGroupId(channel.tsmfGroupId) && !channel.hasConfigTsmfGroupId) {
                record.groupId = channel.tsmfGroupId;
                hasData = true;
            }

            const streams = channel.getStreams();
            if (streams.size > 0) {
                record.streams = [];
                for (const info of streams.values()) {
                    const entry: db.ChannelStreamEntry = {
                        streamId: info.streamId,
                        networkId: info.networkId
                    };
                    if (info.relTs !== undefined) {
                        entry.relTs = info.relTs;
                    }
                    if (info.isTlv !== undefined) {
                        entry.isTlv = info.isTlv;
                    }
                    if (info.serviceIds.size > 0) {
                        entry.serviceIds = [...info.serviceIds];
                    }
                    record.streams.push(entry);
                }
                hasData = true;
            }

            if (hasData) {
                records.push(record);
            }
        }
        db.saveChannels(records, _.configIntegrity.channels)
            .catch(e => log.error("channels db save failed: %s", (e as Error).message));
    }

    private _ensureStreamIDIndex(): void {
        if (!this._streamIDIndexDirty) {
            return;
        }

        const index = new Map<number, Map<number, StreamIDIndexItem>>();
        for (const channel of this._items) {
            for (const entry of channel.getStreams().values()) {
                if (entry.streamId === 0) {
                    continue;
                }
                let streams = index.get(entry.networkId);
                if (!streams) {
                    streams = new Map<number, StreamIDIndexItem>();
                    index.set(entry.networkId, streams);
                }
                let item = streams.get(entry.streamId);
                if (!item) {
                    item = {
                        networkId: entry.networkId,
                        streamId: entry.streamId,
                        streamFormat: streamFormatOf(entry.isTlv),
                        channels: []
                    };
                    streams.set(entry.streamId, item);
                }
                if (!item.channels.some(value => value.channel === channel)) {
                    item.channels.push({ channel, entry });
                }
            }
        }
        this._streamIDIndex = index;
        this._streamIDIndexDirty = false;
    }

    private _load(): void {
        log.debug("loading channels...");

        const channels = _.config.channels;

        channels.forEach((channel, i) => {
            if (typeof channel.name !== "string") {
                log.error("invalid type of property `name` in channel#%d configuration", i);
                return;
            }

            if (common.channelTypes.includes(channel.type) === false) {
                log.error("invalid type of property `type` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            if (channel.route !== null && channel.route !== undefined && !common.channelRoutes.includes(channel.route)) {
                log.error("invalid route in channel#%d configuration", i);
                return;
            }
            if (channel.tsmfGroupId !== null && channel.tsmfGroupId !== undefined && !common.isValidTsmfGroupId(channel.tsmfGroupId)) {
                log.error("invalid tsmfGroupId in channel#%d configuration", i);
                return;
            }
            if (typeof channel.channel !== "string") {
                log.error("invalid type of property `channel` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            if (channel.serviceId && typeof channel.serviceId !== "number") {
                log.error("invalid type of property `serviceId` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            if (channel.tsmfRelTs && typeof channel.tsmfRelTs !== "number") {
                log.error("invalid type of property `tsmfRelTs` in channel#%d (%s) configuration", i, channel.name);
                return;
            }

            if (channel.commandVars && typeof channel.commandVars !== "object") {
                log.error("invalid type of property `commandVars` in channel#%d (%s) configuration", i, channel.name);
                return;
            }
            if (!channel.commandVars) {
                channel.commandVars = {};
            }
            if (channel.satelite && !channel.satellite) {
                log.warn("renaming deprecated property name `satelite` to `satellite` in channel#%d (%s) configuration", i, channel.name);
                (<any> channel).satellite = channel.satelite;
            }
            if (channel.satellite) {
                // deprecated but not planned to remove (soft migration)
                if (!channel.commandVars.satellite) {
                    channel.commandVars.satellite = channel.satellite;
                }
            }
            if (channel.space) {
                // deprecated but not planned to remove (soft migration)
                if (!channel.commandVars.space) {
                    channel.commandVars.space = channel.space;
                }
            }
            if (channel.freq) {
                // deprecated but not planned to remove (soft migration)
                if (!channel.commandVars.freq) {
                    channel.commandVars.freq = channel.freq;
                }
            }
            if (channel.polarity) {
                // deprecated but not planned to remove (soft migration)
                if (!channel.commandVars.polarity) {
                    channel.commandVars.polarity = channel.polarity;
                }
            }
            for (const key in channel.commandVars) {
                if (typeof channel.commandVars[key] !== "number" && typeof channel.commandVars[key] !== "string") {
                    log.error("invalid type of property `commandVars.%s` in channel#%d (%s) configuration", key, i, channel.name);
                    delete channel.commandVars[key];
                }
            }

            if (channel.isDisabled === true) {
                return;
            }

            if (_.tuner.typeExists(channel.type) === false) {
                return;
            }

            let item = this.get(channel.type, channel.channel, channel.route ?? common.defaultRouteForType(channel.type));
            if (!item) {
                item = new ChannelItem(channel);
                this.add(item);
            }
            if (channel.serviceId !== null && channel.serviceId !== undefined) {
                item.addServiceId(channel.serviceId, channel.tsmfRelTs ?? 0, true);
            }
        });
    }

    private async _epgGatherer(): Promise<void> {
        const startup = this._startup;
        if (this._startup === true) {
            this._startup = false;
        }

        const addEPGJob = (networkId, service) => {
            _.job.add({
                key: `EPG.Gather.NID.${networkId}`,
                name: `EPG Gather Network#${networkId}`,
                isRerunnable: true,
                fn: async () => {
                    log.info("Network#%d EPG gathering has started", networkId);
                    try {
                        await _.tuner.getEPG(service.channel);
                        log.info("Network#%d EPG gathering has finished", networkId);
                    } catch (e) {
                        log.warn("Network#%d EPG gathering has failed [%s]", networkId, e);
                        throw new Error("EPG gathering failed");
                    }
                },
                readyFn: async () => {
                    await common.sleep(100);

                    if (status.epg[networkId] === true) {
                        log.info("Network#%d EPG gathering is already in progress on another stream", networkId);
                        return false;
                    }
                    if (service.epgReady === true) {
                        const now = Date.now();
                        if (startup && now - service.epgUpdatedAt < 1000 * 60 * 10) { // 10 mins
                            log.info("Network#%d EPG gathering has skipped because EPG is already up to date (in 10 mins)", networkId);
                            return false;
                        }
                        if (now - service.epgUpdatedAt > 1000 * 60 * 60 * 12) { // 12 hours
                            log.info("Network#%d EPG gathering is resuming forcibly because reached maximum pause time (12 hours)", networkId);
                            service.epgReady = false;
                        } else {
                            const currentPrograms = _.program.findByNetworkIdAndTime(networkId, now)
                                .filter(program => !!program.name && program.name !== "放送休止");
                            if (currentPrograms.length === 0) {
                                const networkPrograms = _.program.findByNetworkId(networkId);
                                if (networkPrograms.length > 0) {
                                    log.info("Network#%d EPG gathering has skipped because broadcast is off", networkId);
                                    return false;
                                }
                                service.epgReady = false;
                            }
                        }
                    }

                    return _.tuner.readyForJob(service.channel);
                }
            });
        };

        const addBS4KEPGJob = (networkId, service) => {
            _.job.add({
                key: `EPG.Gather.NID.${networkId}.SID.${service.id}`,
                name: `EPG Gather Network#${networkId} Service#${service.id}`,
                isRerunnable: true,
                fn: async () => {
                    log.info("Network#%d Service#%d EPG gathering has started", networkId, service.id);
                    try {
                        await _.tuner.getEPG(service.channel);
                        log.info("Network#%d Service#%d EPG gathering has finished", networkId, service.id);
                    } catch (e) {
                        log.warn("Network#%d Service#%d EPG gathering has failed [%s]", networkId, service.id, e);
                        throw new Error("EPG gathering failed");
                    }
                },
                readyFn: async () => {
                    await common.sleep(100);

                    if (service.epgReady === true) {
                        const now = Date.now();
                        if (startup && now - service.epgUpdatedAt < 1000 * 60 * 10) { // 10 mins
                            log.info("Network#%d Service#%d EPG gathering has skipped because EPG is already up to date (in 10 mins)", networkId, service.id);
                            return false;
                        }
                        if (now - service.epgUpdatedAt > 1000 * 60 * 60 * 12) { // 12 hours
                            log.info("Network#%d Service#%d EPG gathering is resuming forcibly because reached maximum pause time (12 hours)", networkId, service.id);
                            service.epgReady = false;
                        } else {
                            const currentPrograms = _.program.findByNetworkIdAndServiceIdAndTime(networkId, service.id, now)
                                .filter(program => !!program.name && program.name !== "放送休止");
                            if (currentPrograms.length === 0) {
                                const networkServicePrograms = _.program.findByNetworkIdServiceId(networkId, service.id);
                                if (networkServicePrograms.length > 0) {
                                    log.info("Network#%d Service#%d EPG gathering has skipped because broadcast is off", networkId, service.id);
                                    return false;
                                }
                                service.epgReady = false;
                            }
                        }
                    }

                    return _.tuner.readyForJob(service.channel);
                }
            });
        };

        const networkIds = [...new Set(_.service.items.map(item => item.networkId))];

        for (const networkId of networkIds) {
            const services = _.service.findByNetworkId(networkId);
            if (services.length === 0) {
                continue;
            }
            const service = services[0];

            if (service.channel.type === "BS4K") {
                for (const serviceItem of services) {
                    addBS4KEPGJob(networkId, serviceItem);
                }
            } else {
                addEPGJob(networkId, service);
            }
        }
    }
}

export default Channel;
