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
import { PassThrough, Writable } from "stream";
import * as common from "./common";
import * as log from "./log";
import * as apid from "../../api";
import _ from "./_";
import TunerDevice, { TunerDeviceStatus, TunerStartupError } from "./TunerDevice";
import ChannelItem from "./ChannelItem";
import ServiceItem from "./ServiceItem";
import StreamFilter from "./StreamFilter";
import { TSHandoffOptions } from "./TSHandoff";

export interface RemoteServiceSource {
    tunerNames: string[];
    services: apid.Service[];
}

export interface RemoteServicesResult {
    sources: RemoteServiceSource[];
    failedSourceCount: number;
}

const CHANNEL_FAILURE_COOLDOWN_MS = 30000;
const SOURCE_FAILURE_COOLDOWN_MS = 30000;
const SOURCE_RECOVERY_STABLE_MS = 30000;
const SOURCE_RECOVERY_MAX_DATA_GAP_MS = 5000;

interface SourceFailureState {
    retryAt: number;
    probing: boolean;
    generation: number;
    probeDeviceIndex?: number;
    probeChannelKey?: string;
    timer?: NodeJS.Timeout;
}

export class Tuner {
    private _devices: TunerDevice[] = [];
    private _readyForJobPickedDeviceSet: Set<TunerDevice> = new Set();
    private _handoffFailureUntil = new Map<string, number>();
    private _channelFailureUntil = new Map<string, number>();
    private _sourceFailureState = new Map<string, SourceFailureState>();

    constructor() {
        this._load();
    }

    get devices(): TunerDeviceStatus[] {
        return this._devices.map(device => device.toJSON());
    }

    get(index: number): TunerDevice {
        const l = this._devices.length;
        for (let i = 0; i < l; i++) {
            if (this._devices[i].index === index) {
                return this._devices[i];
            }
        }

        return null;
    }

    /**
     * readyFn
     */
    async readyForJob(channel: ChannelItem, signal?: AbortSignal): Promise<boolean> {
        if (signal?.aborted) { return false; }
        const allDevices = this._getDevicesByChannel(channel);
        if (allDevices.length === 0) {
            log.error("readyForJob: no tuners for channel: %s (type=%s, allowedTuners=%s)", channel.name, channel.type, channel.allowedTuners?.join(",") || "any");
            return false;
        }

        if (this._isRemoteOnly(allDevices)) {
            return true;
        }

        // For background jobs, prefer local tuners but fall back to remote tuners
        // when every local tuner is occupied (e.g. by a foreground stream),
        // so background jobs (EPG gathering / service scan) can run alongside streams.
        const localDevices = allDevices.filter(d => !d.isRemote);
        const remoteDevices = allDevices.filter(d => d.isRemote);

        while (true) {
            if (signal?.aborted) { return false; }
            const localPickable = localDevices.filter(device => !this._readyForJobPickedDeviceSet.has(device));
            const remotePickable = remoteDevices.filter(device => !this._readyForJobPickedDeviceSet.has(device));

            let device: TunerDevice | null = null;
            if (localPickable.length > 0) {
                device = this._pickTunerDevice(localPickable, channel, -1);
            }
            if (device === null && remotePickable.length > 0 && localDevices.every(d => d.isFree === false)) {
                device = this._pickTunerDevice(remotePickable, channel, -1);
                if (device !== null) {
                    log.info(
                        "readyForJob: falling back to remote tuner #%d (%s) because local tuners are busy",
                        device.index,
                        device.config.name
                    );
                }
            }

            if (device === null) {
                log.debug("readyForJob: no pickable tuners for channel type: %s", channel.type);
                if (signal?.aborted) {
                    return false;
                }
                await common.sleep(1000 * 10);
                if (signal?.aborted) {
                    return false;
                }
                continue;
            }

            // pick したチューナーを少し保持する
            this._readyForJobPickedDeviceSet.add(device);
            log.debug("readyForJob: picked device: #%d (%s)", device.index, device.config.name);

            setTimeout(() => {
                // 開放
                this._readyForJobPickedDeviceSet.delete(device);
                log.debug("readyForJob: released device: #%d (%s)", device.index, device.config.name);
            }, 1000 * 5);

            return true;
        }
    }

    typeExists(type: apid.ChannelType): boolean {
        const l = this._devices.length;
        for (let i = 0; i < l; i++) {
            if (this._devices[i].config.types.includes(type) === true) {
                return true;
            }
        }

        return false;
    }

    getRemoteOnlyTypes(): apid.ChannelType[] {
        return common.channelTypes.filter(type => {
            const devices = this._getDevicesByType(type);
            return this._isRemoteOnly(devices);
        });
    }

    async getRemoteServicesByType(type: apid.ChannelType): Promise<RemoteServicesResult> {
        const devices = this._getDevicesByType(type);
        if (this._isRemoteOnly(devices) === false) {
            throw new Error(`channel type \`${type}\` is not remote-only`);
        }

        const remoteSources = new Map<string, {
            host: string;
            port: number;
            tunerNames: string[];
            allowNested: boolean;
        }>();

        for (const device of devices) {
            const host = device.config.remoteMirakurunHost;
            const port = device.config.remoteMirakurunPort || 40772;
            const allowNested = device.config.remoteMirakurunAllowNested === true;
            const key = JSON.stringify([host, port, allowNested]);
            const source = remoteSources.get(key);
            if (source) {
                source.tunerNames.push(device.config.name);
            } else {
                remoteSources.set(key, {
                    host,
                    port,
                    tunerNames: [device.config.name],
                    allowNested
                });
            }
        }

        const results = await Promise.allSettled([...remoteSources.values()].map(async source => {
            const Client = require("../client").default;
            const client = new Client();
            client.host = source.host;
            client.port = source.port;
            client.userAgent = "Mirakurun (Remote Service Sync)";

            const services = await client.getServices({
                "channel.type": common.getTuningChannelType(type)
            }, {
                localTunerOnly: source.allowNested === false
            });
            log.info(
                "Fetched %d services for channel type %s from remote Mirakurun %s:%d (%s)",
                services.length,
                type,
                source.host,
                source.port,
                source.tunerNames.join(",")
            );

            return {
                tunerNames: source.tunerNames,
                services
            };
        }));

        const sources: RemoteServiceSource[] = [];
        let failedSourceCount = 0;

        results.forEach((result, index) => {
            if (result.status === "fulfilled") {
                sources.push(result.value);
                return;
            }

            const source = [...remoteSources.values()][index];
            failedSourceCount++;
            log.warn(
                "Failed to fetch services for channel type %s from remote Mirakurun %s:%d (%s) [%s]",
                type,
                source.host,
                source.port,
                source.tunerNames.join(","),
                result.reason
            );
        });

        return {
            sources,
            failedSourceCount
        };
    }

    initChannelStream(channel: ChannelItem, userReq: common.UserRequest, output: Writable, tsmfRelTs?: number): Promise<StreamFilter> {
        let networkId: number;

        const services = channel.getServices();
        if (services.length !== 0) {
            networkId = services[0].networkId;
        }

        return this._initTS({
            ...userReq,
            streamSetting: {
                channel,
                networkId,
                tsmfRelTs,
                parseEIT: true
            }
        }, output);
    }

    hasLocalTunerForChannel(channel: ChannelItem): boolean {
        return this._getDevicesByChannel(channel).some(device => device.isRemote === false);
    }

    initStreamIDStream(networkId: number, streamId: number, userReq: common.UserRequest, output: Writable): Promise<StreamFilter> {
        const item = _.channel.getStreamID(networkId, streamId);
        if (!item) {
            return Promise.reject(new Error("stream not found"));
        }
        const channels = item.channels.map(value => value.channel);
        return this._initTS({
            ...userReq,
            streamSetting: { channel: channels[0], channels, networkId, streamId,
                streamFormat: item.streamFormat, parseEIT: true }
        }, output);
    }

    initServiceStream(service: ServiceItem, userReq: common.UserRequest, output: Writable, preferredChannel?: ChannelItem): Promise<StreamFilter> {
        return this._initTS({
            ...userReq,
            streamSetting: {
                channel: preferredChannel ?? service.channel,
                channels: preferredChannel ? [preferredChannel] : service.channels,
                serviceId: service.serviceId,
                networkId: service.networkId,
                parseEIT: true
            }
        }, output);
    }

    initProgramStream(program: apid.Program, userReq: common.UserRequest, output: Writable): Promise<StreamFilter> {
        return this._initTS({
            ...userReq,
            streamSetting: {
                channel: _.service.get(program.networkId, program.serviceId).channel,
                channels: _.service.get(program.networkId, program.serviceId).channels,
                serviceId: program.serviceId,
                eventId: program.eventId,
                networkId: program.networkId,
                parseEIT: true
            }
        }, output);
    }

    async getEPG(channel: ChannelItem, time?: number, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) { return; }
        let timeout: NodeJS.Timeout;
        if (!time) {
            time = _.config.server.epgRetrievalTime || 1000 * 60 * 10;
        }

        let networkId: number;

        const services = channel.getServices();
        if (services.length === 0) {
            throw new Error("no available services in channel");
        }

        networkId = services[0].networkId;

        const tsFilter = await this._initTS({
            id: "Mirakurun:getEPG()",
            priority: -1,
            disableDecoder: true,
            streamSetting: {
                channel,
                networkId,
                parseEIT: true
            }
        });

        if (tsFilter === null) {
            return;
        }

        return new Promise<void>((resolve) => {
            const fin = () => {
                clearTimeout(timeout);
                tsFilter.close();
            };
            timeout = setTimeout(fin, time);
            tsFilter.once("epgReady", fin);
            tsFilter.once("close", () => {
                clearTimeout(timeout);
                signal?.removeEventListener("abort", fin);
                resolve();
            });
            signal?.addEventListener("abort", fin, { once: true });
            if (signal?.aborted) { fin(); }
        });
    }

    async getServices(channel: ChannelItem, user: Partial<common.User> = {}): Promise<apid.Service[]> {
        const devices = this._getDevicesByChannel(channel);
        const remoteDevice = this._getRemoteOnlyDevice(devices);

        if (remoteDevice !== null) {
            log.info("Fetching services for channel %s from remote Mirakurun %s:%d via API",
                channel.name, remoteDevice.config.remoteMirakurunHost, remoteDevice.config.remoteMirakurunPort || 40772);

            const Client = require("../client").default;
            const client = new Client();
            client.host = remoteDevice.config.remoteMirakurunHost;
            client.port = remoteDevice.config.remoteMirakurunPort || 40772;
            client.userAgent = "Mirakurun (Remote Service Scanner)";

            try {
                const services = await client.getServices({
                    "channel.type": common.getTuningChannelType(channel.type),
                    "channel.channel": channel.channel
                });
                log.info("Fetched %d services for channel %s from remote Mirakurun", services.length, channel.name);
                return services;
            } catch (err) {
                log.error("Failed to fetch services from remote Mirakurun for channel %s: %s", channel.name, err.message);
                throw err;
            }
        }

        // Fallback to stream-based scanning (original logic)
        channel.beginStreamScan();
        const tsFilter = await this._initTS({
            id: "Mirakurun:getServices()",
            priority: -1,
            disableDecoder: true,
            streamSetting: {
                channel,
                parseNIT: true,
                parseSDT: true
            },
            ...user
        }).catch(error => {
            channel.rollbackStreamScan();
            throw error;
        });
        return new Promise<apid.Service[]>((resolve, reject) => {
            let network = {
                networkId: -1,
                areaCode: -1,
                remoteControlKeyId: -1
            };
            let services: apid.Service[] = null;

            const timeout = setTimeout(() => tsFilter.close(), 30000);

            Promise.all<void>([
                new Promise((resolve, reject) => {
                    tsFilter.once("network", _network => {
                        network = _network;
                        resolve();
                    });
                }),
                new Promise((resolve, reject) => {
                    tsFilter.once("services", _services => {
                        services = _services;
                        resolve();
                    });
                })
            ]).then(() => tsFilter.close());

            tsFilter.once("close", () => {
                clearTimeout(timeout);
                tsFilter.removeAllListeners("network");
                tsFilter.removeAllListeners("services");

                if (network.networkId === -1) {
                    channel.rollbackStreamScan();
                    reject(new Error("stream has closed before get network"));
                } else if (services === null) {
                    channel.rollbackStreamScan();
                    reject(new Error("stream has closed before get services"));
                } else {
                    if (network.remoteControlKeyId !== -1) {
                        services.forEach(service => {
                            if (service.networkId === network.networkId && service.remoteControlKeyId === undefined) {
                                service.remoteControlKeyId = network.remoteControlKeyId;
                            }
                        });
                    }

                    for (const service of services) {
                        const entry = channel.getStreamForService(service.serviceId);
                        if (entry && entry.networkId === service.networkId && entry.streamId !== 0) {
                            service.streamId = entry.streamId;
                            service.tsmfRelTs = entry.relTs;
                        }
                    }
                    channel.commitStreamScan(false);
                    _.channel.save?.();
                    resolve(services);
                }
            });
        });
    }

    private _load(): this {
        log.debug("loading tuners...");

        const tuners = _.config.tuners;

        tuners.forEach((tuner, i) => {
            if (!tuner.name || !tuner.types || (!tuner.remoteMirakurunHost && !tuner.command && !tuner.commandBS4K)) {
                log.error("missing required property in tuner#%s configuration", i);
                return;
            }

            if (typeof tuner.name !== "string") {
                log.error("invalid type of property `name` in tuner#%s configuration", i);
                return;
            }

            if (Array.isArray(tuner.types) === false) {
                console.log(tuner);
                log.error("invalid type of property `types` in tuner#%s configuration", i);
                return;
            }

            const hasOnlyBS4K = tuner.types.length > 0 && tuner.types.every(type => type === "BS4K");
            if (!tuner.remoteMirakurunHost && !hasOnlyBS4K && typeof tuner.command !== "string") {
                log.error("invalid type of property `command` in tuner#%s configuration", i);
                return;
            }

            if (tuner.command !== undefined && typeof tuner.command !== "string") {
                log.error("invalid type of property `command` in tuner#%s configuration", i);
                return;
            }

            if (tuner.commandBS4K !== undefined && typeof tuner.commandBS4K !== "string") {
                log.error("invalid type of property `commandBS4K` in tuner#%s configuration", i);
                return;
            }

            if (tuner.dvbDevicePath && typeof tuner.dvbDevicePath !== "string") {
                log.error("invalid type of property `dvbDevicePath` in tuner#%s configuration", i);
                return;
            }

            if (tuner.checkDevicePath && typeof tuner.checkDevicePath !== "string") {
                log.error("invalid type of property `checkDevicePath` in tuner#%s configuration", i);
                return;
            }

            if (tuner.cooldownSeconds !== undefined && (!Number.isInteger(tuner.cooldownSeconds) || tuner.cooldownSeconds < 0)) {
                log.error("invalid type of property `cooldownSeconds` in tuner#%s configuration", i);
                return;
            }

            if (tuner.remoteMirakurunHost && typeof tuner.remoteMirakurunHost !== "string") {
                log.error("invalid type of property `remoteMirakurunHost` in tuner#%s configuration", i);
                return;
            }

            if (tuner.remoteMirakurunPort && Number.isInteger(tuner.remoteMirakurunPort) === false) {
                log.error("invalid type of property `remoteMirakurunPort` in tuner#%s configuration", i);
                return;
            }

            if (tuner.remoteMirakurunDecoder !== undefined && typeof tuner.remoteMirakurunDecoder !== "boolean") {
                log.error("invalid type of property `remoteMirakurunDecoder` in tuner#%s configuration", i);
                return;
            }

            if (tuner.remoteMirakurunAllowNested !== undefined && typeof tuner.remoteMirakurunAllowNested !== "boolean") {
                log.error("invalid type of property `remoteMirakurunAllowNested` in tuner#%s configuration", i);
                return;
            }

            if (tuner.mmtsDecoder !== undefined && typeof tuner.mmtsDecoder !== "string") {
                log.error("invalid type of property `mmtsDecoder` in tuner#%s configuration", i);
                return;
            }

            if (tuner.decoder !== undefined && typeof tuner.decoder !== "string") {
                log.error("invalid type of property `decoder` in tuner#%s configuration", i);
                return;
            }

            if (tuner.routes !== undefined && (!Array.isArray(tuner.routes) ||
                tuner.routes.some(route => !common.channelRoutes.includes(route)))) {
                log.error("invalid routes in tuner#%s configuration", i);
                return;
            }
            for (const field of ["tlvDecoder", "tlvToTsDecoder"] as const) {
                if (tuner[field] !== undefined && typeof tuner[field] !== "string") {
                    log.error("invalid %s in tuner#%s configuration", field, i);
                    return;
                }
            }
            if (tuner.isDisabled) {
                return;
            }

            const device = new TunerDevice(i, tuner);
            device.on("streamFailure", (channel: ChannelItem) => this._handleStreamFailure(device, channel));
            this._devices.push(device);
        });

        log.info("%s of %s tuners loaded", this._devices.length, tuners.length);

        return this;
    }

    private async _initTS(user: common.User, dest?: Writable): Promise<StreamFilter | null> {
        const setting = user.streamSetting;
        user = { ...user, disableMMTSDecoder: true };
        const channels = setting.channels?.length ? setting.channels : [setting.channel];
        if (_.config.server.disableEITParsing === true) {
            setting.parseEIT = false;
        }

        const routes = channels.map(channel => ({ channel, devices: this._getDevicesByChannel(channel)
            .filter(device => user.localTunerOnly !== true || device.isRemote === false) }));
        const devices = [...new Set(routes.flatMap(route => route.devices))];
        const recoverUnavailableTuners = user.priority >= 0 && devices.length > 0 && devices.every(device => device.isAvailable === false);
        let tryCount = 50;
        let handoffTried = false;

        if (!dest) {
            const remoteResult = await this._useRemoteData(user, devices);
            if (remoteResult) {
                return null;
            }
        }

        while (tryCount > 0) {
            const disableDecoder = user.disableDecoder === true;
            const disableMMTSDecoder = user.disableMMTSDecoder === true;
            let device: TunerDevice = null;
            // Prefer a local path across all routes before using remote capacity.
            for (const remote of [false, true]) {
                for (const route of routes) {
                    const candidates = route.devices.filter(candidate => candidate.isRemote === remote &&
                        (candidate.canReuseStream(route.channel, disableDecoder, disableMMTSDecoder, user.outputFormat) ||
                            (!this._isSourceFailureCoolingDown(candidate) &&
                                !this._isChannelFailureCoolingDown(candidate, route.channel))));
                    device = this._pickTunerDevice(candidates, route.channel, user.priority,
                        disableDecoder, disableMMTSDecoder, recoverUnavailableTuners, user.outputFormat);
                    if (device) {
                        setting.channel = route.channel;
                        break;
                    }
                }
                if (device) { break; }
            }

            if (device === null) {
                if (handoffTried === false && await this._rebalanceForChannel(setting.channel, user.priority)) {
                    handoffTried = true;
                    continue;
                }
                handoffTried = true;

                // retry
                tryCount--;
                if (tryCount <= 0) {
                    throw new Error("no available tuners");
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            } else {
                // found
                const legacyConverter = device.mmtsDecoder;
                const legacyTlvOutputFormat = legacyConverter &&
                    !device.config.tlvDecoder && !device.config.tlvToTsDecoder
                    ? (user.disableDecoder ? "tlv" : "ts") : undefined;
                const entry = setting.streamId !== undefined
                    ? [...setting.channel.getStreams().values()].find(value =>
                        value.networkId === setting.networkId && value.streamId === setting.streamId)
                    : undefined;
                // Attach the consumer after startup resolves. This keeps first remote
                // bytes behind the API's format/MIME negotiation and lets failed
                // startup attempts close their own sink without ending the consumer.
                const output = dest ? new PassThrough({ highWaterMark: 1024 * 1024 }) : undefined;
                const tsFilter = new StreamFilter({
                    output,
                    decoder: device.decoder,
                    tlvDecoder: device.config.tlvDecoder,
                    tlvToTsDecoder: device.config.tlvToTsDecoder || legacyConverter,
                    disableDecoder,
                    outputFormat: user.outputFormat,
                    legacyTlvOutputFormat,
                    networkId: setting.networkId,
                    serviceId: setting.serviceId,
                    eventId: setting.eventId,
                    parseNIT: setting.parseNIT,
                    parseSDT: setting.parseSDT,
                    parseEIT: setting.parseEIT,
                    tsmfRelTs: setting.tsmfRelTs ?? entry?.relTs ?? setting.channel.getRelTs(setting.serviceId),
                    tsmfDiscovery: setting.tsmfDiscovery,
                    channel: setting.channel,
                    tunerIndex: device.index
                });
                const persistStreams = () => _.channel.save?.();
                tsFilter.on("services", persistStreams);
                tsFilter.on("networkStreams", persistStreams);

                Object.defineProperty(user, "streamInfo", {
                    get: () => tsFilter.streamInfo,
                    configurable: true
                });

                const sourceProbe = this._beginSourceProbe(device, setting.channel);
                try {
                    await device.startStream(user, tsFilter, setting.channel, recoverUnavailableTuners);
                    if (dest) {
                        const onClose = () => { output.destroy(); tsFilter.close(); };
                        dest.once("close", onClose);
                        setImmediate(() => {
                            if (!dest.destroyed && !dest.writableEnded) {
                                output.pipe(dest);
                            } else {
                                onClose();
                            }
                        });
                    }
                    this._clearChannelFailure(device, setting.channel);
                    if (sourceProbe === true) {
                        this._validateSourceRecovery(device, setting.channel);
                    }
                    return tsFilter;
                } catch (err) {
                    output?.destroy();
                    tsFilter.end();
                    if (err instanceof TunerStartupError) {
                        if (err.failureScope === "source") {
                            this._markSourceFailure(device);
                        } else {
                            this._markChannelFailure(device, setting.channel);
                            if (sourceProbe === true) {
                                this._releaseSourceProbe(device);
                            }
                        }
                        log.warn(
                            "TunerDevice#%d failed to start `%s`; retrying with a different tuner [%s]",
                            device.index,
                            setting.channel.name,
                            err.message
                        );
                        continue;
                    }
                    if (sourceProbe === true) {
                        this._releaseSourceProbe(device);
                    }
                    throw err;
                }
            }
        }
    }

    /**
     * リモートデータ利用 (EPG)
     */
    private async _useRemoteData(
        user: common.User,
        devices: TunerDevice[]
    ): Promise<boolean> {
        const setting = user.streamSetting;
        const remoteDevice = this._getRemoteOnlyDevice(devices);

        if (remoteDevice && setting.networkId !== undefined && setting.parseEIT === true) {
            try {
                const programs = await remoteDevice.getRemotePrograms({ networkId: setting.networkId });
                await common.sleep(1000);
                _.program.findByNetworkIdAndReplace(setting.networkId, programs);
                for (const service of _.service.findByNetworkId(setting.networkId)) {
                    service.epgReady = true;
                }
                await common.sleep(1000);
                return true;
            } catch (err) {
                throw err;
            }
        }

        return false;
    }

    private _getRemoteOnlyDevice(devices: TunerDevice[]): TunerDevice | null {
        if (this._isRemoteOnly(devices) === false) {
            return null;
        }

        return devices[0];
    }

    private _isRemoteOnly(devices: TunerDevice[]): boolean {
        return devices.length > 0 && devices.every(device => device.isRemote);
    }

    /**
     * チューナーデバイス探索
     */
    private _pickTunerDevice(
        devices: TunerDevice[],
        channel: ChannelItem,
        priority: number,
        disableDecoder = false,
        disableMMTSDecoder = disableDecoder,
        recoverUnavailableTuners = false,
        outputFormat?: apid.StreamFormat
    ): TunerDevice | null {
        const localDevices = devices.filter(device => device.isRemote === false);
        const remoteDevices = devices.filter(device => device.isRemote === true);

        // 1. join to existing
        for (const device of [...localDevices, ...remoteDevices]) {
            if (device.isAvailable === true && device.canReuseStream(channel, disableDecoder, disableMMTSDecoder, outputFormat) === true) {
                return device;
            }
        }

        // 2. start as new on local tuners
        for (const device of localDevices) {
            if (device.isFree === true && device.canStartStream(channel) === true) {
                return device;
            }
        }

        // 3. replace existing on local tuners
        for (const device of localDevices) {
            if (device.isAvailable === true && device.users.length === 0 && device.canStartStream(channel) === true) {
                return device;
            }
        }

        // 4. preempt background jobs (EPG / service scan) on local tuners for foreground streams
        if (priority >= 0) {
            for (const device of localDevices) {
                if (device.isUsing === true &&
                    device.channel !== channel &&
                    device.getPriority() < priority &&
                    device.users.every(user => user.priority < 0) === true &&
                    device.canStartStream(channel) === true
                ) {
                    log.info(
                        "TunerDevice#%d is running a background job for `%s`; preempting it for foreground stream `%s`",
                        device.index,
                        device.channel.name,
                        channel.name
                    );
                    this._requeueBackgroundJobs(device);
                    return device;
                }
            }
        }

        // 5. start as new on remote tuners
        for (const device of remoteDevices) {
            if (device.isFree === true && device.canStartStream(channel) === true) {
                return device;
            }
        }

        // 6. replace existing on remote tuners
        for (const device of remoteDevices) {
            if (device.isAvailable === true && device.users.length === 0 && device.canStartStream(channel) === true) {
                return device;
            }
        }

        // 7. takeover existing
        if (priority >= 0) {
            devices.sort((t1, t2) => t1.getPriority() - t2.getPriority());
            for (const device of devices) {
                if (device.isUsing === true && device.getPriority() < priority && device.canStartStream(channel) === true) {
                    return device;
                }
            }
        }

        // 8. recover unavailable tuners
        // If every tuner for this channel type is unavailable, keep one attempt path open
        // for foreground/external requests instead of letting background failures deadlock the type.
        if (recoverUnavailableTuners === true) {
            devices.sort((t1, t2) => t1.getPriority() - t2.getPriority());
            for (const device of devices) {
                if (device.getPriority() <= priority && device.canStartStream(channel, true) === true) {
                    return device;
                }
            }
        }

        return null;
    }

    /**
     * フォアグラウンドのストリームがバックグラウンドジョブを preempt した後、
     * 次の EPG.Gatherer スケジュールを待たずに、中断された EPG 収集をすぐに再スケジュールする。
     */
    private _requeueBackgroundJobs(device: TunerDevice): void {
        for (const user of device.users) {
            if (user.id === "Mirakurun:getEPG()") {
                _.job.runSchedule("EPG.Gatherer");
                return;
            }
        }
    }

    private async _rebalanceForChannel(channel: ChannelItem, priority: number): Promise<boolean> {
        const config = _.config.server.tunerHandoff;

        if (!config || config.enabled !== true) {
            return false;
        }
        if (priority < 0) {
            return false;
        }

        const requestDevices = this._getDevicesByChannel(channel);
        const handoffOptions = this._getHandoffOptions();

        for (const blockingDevice of requestDevices) {
            if (blockingDevice.isUsing === false || blockingDevice.channel === channel) {
                continue;
            }

            const moveTargets = this._getDevicesByChannel(blockingDevice.channel);
            for (const moveTarget of moveTargets) {
                if (moveTarget === blockingDevice || this._readyForJobPickedDeviceSet.has(moveTarget)) {
                    continue;
                }
                const handoffKey = this._getHandoffKey(blockingDevice, moveTarget, blockingDevice.channel);
                const failureUntil = this._handoffFailureUntil.get(handoffKey) || 0;
                if (failureUntil > Date.now()) {
                    continue;
                }
                if (blockingDevice.canHandoffTo(moveTarget, priority) === false) {
                    continue;
                }

                log.info(
                    "Tuner rebalance: moving `%s` from #%d to #%d to free tuner for `%s`",
                    blockingDevice.channel.name,
                    blockingDevice.index,
                    moveTarget.index,
                    channel.name
                );

                if (await blockingDevice.handoffAllUsersTo(moveTarget, priority, handoffOptions)) {
                    this._handoffFailureUntil.delete(handoffKey);
                    return true;
                }

                this._handoffFailureUntil.set(
                    handoffKey,
                    Date.now() + Math.max(10000, handoffOptions.syncTimeoutMs)
                );
            }
        }

        return false;
    }

    private _getHandoffKey(source: TunerDevice, target: TunerDevice, channel: ChannelItem): string {
        return `${source.index}:${target.index}:${channel.type}:${channel.route}:${channel.channel}`;
    }

    private _getHandoffOptions(): TSHandoffOptions {
        const config = _.config.server.tunerHandoff || {};

        return {
            warmupMs: config.warmupMs ?? 0,
            maxBufferMs: config.maxBufferMs ?? 10000,
            switchMarginMs: config.switchMarginMs ?? 100,
            syncTimeoutMs: config.syncTimeoutMs ?? 5000
        };
    }

    private _getChannelFailureKey(device: TunerDevice, channel: ChannelItem): string {
        return `${this._getSourceKey(device)}:${channel.type}:${channel.route}:${channel.channel}`;
    }

    private _getSourceKey(device: TunerDevice): string {
        return device.isRemote
            ? `${device.config.remoteMirakurunHost}:${device.config.remoteMirakurunPort || 40772}`
            : `device:${device.index}`;
    }

    private _getProbeChannelKey(channel: ChannelItem): string {
        return `${channel.type}:${channel.route}:${channel.channel}`;
    }

    private _isSourceFailureCoolingDown(device: TunerDevice): boolean {
        if (device.isRemote === false) {
            return false;
        }

        const state = this._sourceFailureState.get(this._getSourceKey(device));
        if (!state) {
            return false;
        }

        return state.probing === true || state.retryAt > Date.now();
    }

    private _beginSourceProbe(device: TunerDevice, channel: ChannelItem): boolean {
        if (device.isRemote === false) {
            return false;
        }

        const state = this._sourceFailureState.get(this._getSourceKey(device));
        if (!state || state.probing === true || state.retryAt > Date.now()) {
            return false;
        }

        state.probing = true;
        state.generation++;
        state.probeDeviceIndex = device.index;
        state.probeChannelKey = this._getProbeChannelKey(channel);
        log.warn(
            "Remote tuner source %s is half-open; TunerDevice#%d will probe `%s`",
            this._getSourceKey(device),
            device.index,
            channel.name
        );
        return true;
    }

    private _releaseSourceProbe(device: TunerDevice): void {
        const state = this._sourceFailureState.get(this._getSourceKey(device));
        if (!state || state.probing === false) {
            return;
        }

        if (state.timer) {
            clearTimeout(state.timer);
        }
        state.probing = false;
        state.retryAt = Date.now();
        state.generation++;
        delete state.probeDeviceIndex;
        delete state.probeChannelKey;
        delete state.timer;
    }

    private _validateSourceRecovery(device: TunerDevice, channel: ChannelItem): void {
        const key = this._getSourceKey(device);
        const state = this._sourceFailureState.get(key);
        if (!state || state.probing === false) {
            return;
        }

        const generation = state.generation;
        state.timer = setTimeout(
            () => this._completeSourceRecoveryProbe(device, channel, key, generation),
            SOURCE_RECOVERY_STABLE_MS
        );
        state.timer.unref();
    }

    private _completeSourceRecoveryProbe(
        device: TunerDevice,
        channel: ChannelItem,
        key: string,
        generation: number
    ): void {
        const current = this._sourceFailureState.get(key);
        if (!current || current.generation !== generation || current.probing === false) {
            return;
        }

        const isStable = device.isUsing === true &&
            device.channel === channel &&
            Date.now() - device.lastDataAt <= SOURCE_RECOVERY_MAX_DATA_GAP_MS;
        if (isStable === true) {
            this._sourceFailureState.delete(key);
            log.info(
                "Remote tuner source %s recovered after %d seconds of stable streaming",
                key,
                SOURCE_RECOVERY_STABLE_MS / 1000
            );
            return;
        }

        if (device.isUsing === true && device.channel === channel) {
            log.warn("Remote tuner source %s recovery probe stopped producing data", key);
            this._markSourceFailure(device);
            device.kill().catch(log.error);
        } else {
            log.warn("Remote tuner source %s recovery probe ended before validation completed", key);
            this._releaseSourceProbe(device);
        }
    }

    private _isActiveSourceProbe(device: TunerDevice, channel: ChannelItem): boolean {
        const state = this._sourceFailureState.get(this._getSourceKey(device));
        return !!state &&
            state.probing === true &&
            state.probeDeviceIndex === device.index &&
            state.probeChannelKey === this._getProbeChannelKey(channel);
    }

    private _markSourceFailure(device: TunerDevice): void {
        if (device.isRemote === false) {
            return;
        }

        const key = this._getSourceKey(device);
        const previous = this._sourceFailureState.get(key);
        if (previous?.timer) {
            clearTimeout(previous.timer);
        }
        this._sourceFailureState.set(key, {
            retryAt: Date.now() + SOURCE_FAILURE_COOLDOWN_MS,
            probing: false,
            generation: (previous?.generation || 0) + 1
        });
        log.warn(
            "Remote tuner source %s will be avoided for %d seconds after connection failure",
            key,
            SOURCE_FAILURE_COOLDOWN_MS / 1000
        );
    }

    private _handleStreamFailure(device: TunerDevice, channel: ChannelItem): void {
        if (this._isActiveSourceProbe(device, channel) === true) {
            this._markSourceFailure(device);
        } else {
            this._markChannelFailure(device, channel);
        }
    }

    private _isChannelFailureCoolingDown(device: TunerDevice, channel: ChannelItem): boolean {
        const key = this._getChannelFailureKey(device, channel);
        const failureUntil = this._channelFailureUntil.get(key) || 0;
        if (failureUntil <= Date.now()) {
            this._channelFailureUntil.delete(key);
            return false;
        }

        return true;
    }

    private _markChannelFailure(device: TunerDevice, channel: ChannelItem): void {
        if (!channel) {
            return;
        }

        const key = this._getChannelFailureKey(device, channel);
        this._channelFailureUntil.set(key, Date.now() + CHANNEL_FAILURE_COOLDOWN_MS);
        log.warn(
            "TunerDevice#%d will avoid channel `%s` for %d seconds after stream failure",
            device.index,
            channel.name,
            CHANNEL_FAILURE_COOLDOWN_MS / 1000
        );
    }

    private _clearChannelFailure(device: TunerDevice, channel: ChannelItem): void {
        this._channelFailureUntil.delete(this._getChannelFailureKey(device, channel));
    }

    private _getDevicesByChannel(channel: ChannelItem): TunerDevice[] {
        const devices = [];

        for (const device of this._getDevicesByType(channel.type)) {
            if (device.config.routes?.length && !device.config.routes.includes(channel.route)) {
                continue;
            }
            // if channel specifies allowedTuners, only return matching tuners
            if (channel.allowedTuners !== undefined) {
                if (channel.allowedTuners.includes(device.config.name)) {
                    devices.push(device);
                }
            } else {
                // no allowedTuners specified, return all tuners with matching type
                devices.push(device);
            }
        }

        return devices;
    }

    private _getDevicesByType(type: apid.ChannelType): TunerDevice[] {
        const devices = [];

        for (const device of this._devices) {
            if (device.config.types.includes(type) === true) {
                devices.push(device);
            }
        }

        return devices;
    }
}

export default Tuner;
