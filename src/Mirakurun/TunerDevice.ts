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
import * as child_process from "child_process";
import { existsSync } from "fs";
import * as stream from "stream";
import * as util from "util";
import EventEmitter = require("eventemitter3");
import * as common from "./common";
import * as log from "./log";
import * as config from "./config";
import * as apid from "../../api";
import status from "./status";
import Event from "./Event";
import ChannelItem from "./ChannelItem";
import _ from "./_";
import TSFilter from "./TSFilter";
import StreamFilter from "./StreamFilter";
import Client, { ProgramsQuery } from "../client";
import { REMOTE_EXIT_CHANNEL_UNAVAILABLE } from "../remoteExitCodes";
import { TSHandoffBuffer, TSHandoffOptions, TSHandoffProbe } from "./TSHandoff";

const DEFAULT_FAILURE_COOLDOWN_SECONDS = 2;
const REMOTE_STREAM_START_TIMEOUT_MS = 5000;

export type TunerStartupFailureScope = "channel" | "source";

export class TunerStartupError extends Error {
    constructor(message: string, readonly failureScope: TunerStartupFailureScope) {
        super(message);
    }
}

interface StreamSink {
    readonly closed: boolean;
    write(chunk: Buffer): boolean | void;
    close(): void;
    end(): void;
    once(event: "close", listener: () => void): unknown;
    syncPriorities?(priority: number): void;
    releaseTsmfCarriers?(): void;
}

interface User extends common.User {
    _stream?: StreamSink;
}

interface StartStreamOptions {
    suppressGroupCombine?: boolean;
}

export interface TunerDeviceStatus {
    readonly index: number;
    readonly name: string;
    readonly types: apid.ChannelType[];
    readonly command: string;
    readonly pid: number;
    readonly users: common.User[];
    readonly isAvailable: boolean;
    readonly isRemote: boolean;
    readonly isFree: boolean;
    readonly isUsing: boolean;
    readonly isFault: boolean;
}

export default class TunerDevice extends EventEmitter {
    private _channel: ChannelItem = null;
    private _command: string = null;
    private _process: child_process.ChildProcess = null;
    private _mmtsDecoderProcess: child_process.ChildProcess = null;
    private _stream: stream.Readable = null;
    private _streamUsesMMTSDecoder = false;
    private _remoteDecode: boolean | null = null;
    private _remoteOutputFormat: apid.StreamFormat | undefined;

    private _users = new Set<User>();
    private _handoffProbe: TSHandoffProbe = null;
    private _handoffInProgress = false;

    private _isAvailable = true;
    private _isRemote = false;
    private _isFault = false;
    private _fatalCount = 0;
    private _exited = false;
    private _closing = false;
    private _lastDevicePathReady: boolean = null;
    private _cooldownUntil = 0;
    private _lastCooldownLogUntil = 0;
    private _lastDataAt = 0;
    private _commandFailed = false;

    constructor(private _index: number, private _config: apid.ConfigTunersItem) {
        super();
        this._isRemote = !!this._config.remoteMirakurunHost;
        Event.emit("tuner", "create", this.toJSON());
        log.debug("TunerDevice#%d initialized", this._index);
    }

    get index(): number {
        return this._index;
    }

    get config(): apid.ConfigTunersItem {
        return this._config;
    }

    get channel(): ChannelItem {
        return this._channel;
    }

    get command(): string {
        return this._command;
    }

    get pid(): number {
        return this._process ? this._process.pid : null;
    }

    get users(): User[] {
        return [...this._users].map(user => {
            return {
                id: user.id,
                priority: user.priority,
                agent: user.agent,
                url: user.url,
                disableDecoder: user.disableDecoder,
                disableMMTSDecoder: user.disableMMTSDecoder,
                streamSetting: user.streamSetting,
                streamInfo: user.streamInfo
            };
        });
    }

    get decoder(): string | null {
        if (this._isRemote && this._config.remoteMirakurunDecoder === true) {
            return null;
        }
        return this._config.decoder || null;
    }

    get mmtsDecoder(): string {
        return this._config.mmtsDecoder || null;
    }

    get isAvailable(): boolean {
        return this._isAvailable;
    }

    get isRemote(): boolean {
        return this._isRemote;
    }

    get isFree(): boolean {
        return this._isAvailable === true && this._channel === null && this._users.size === 0;
    }

    get isUsing(): boolean {
        return this._isAvailable === true && this._channel !== null && this._users.size !== 0;
    }

    get isFault(): boolean {
        return this._isFault;
    }

    get isAdditionalCarrier(): boolean {
        return [...this._users].some(user => user.id === "Mirakurun:addCarrier()");
    }

    get lastDataAt(): number {
        return this._lastDataAt;
    }

    get checkDevicePath(): string {
        return this._config.checkDevicePath || this._config.dvbDevicePath || null;
    }

    canReuseStream(
        channel: ChannelItem,
        disableDecoder: boolean,
        disableMMTSDecoder = disableDecoder,
        outputFormat?: apid.StreamFormat
    ): boolean {
        if (this._channel !== channel || this._canUseChannel(channel) === false) {
            return false;
        }
        if (this._canFanoutMMTSDecoder(channel) === true) {
            return true;
        }

        if (this._isRemote &&
            (this._remoteDecode !== this._remoteDecodeFor(disableDecoder) ||
                this._remoteOutputFormat !== outputFormat)) {
            return false;
        }

        return this._streamUsesMMTSDecoder === this._shouldUseMMTSDecoder(channel, disableMMTSDecoder);
    }

    getPriority(): number {
        let priority = -2;

        for (const user of this._users) {
            if (user.priority > priority) {
                priority = user.priority;
            }
        }

        return priority;
    }

    canHandoffTo(device: TunerDevice, priority: number): boolean {
        if (this._handoffInProgress || device._handoffInProgress || device === this) {
            return false;
        }
        if (this.isUsing === false || this._channel === null || this._hasDetectedNonTsStream()) {
            return false;
        }
        if (device.isFree === false || device.canStartStream(this._channel) === false) {
            return false;
        }
        if (priority >= 0 && this.getPriority() > priority) {
            return false;
        }

        return true;
    }

    canStartStream(channel?: ChannelItem, ignoreAvailability = false): boolean {
        if (ignoreAvailability === false && this._isAvailable === false) {
            return false;
        }
        if (channel && this._canUseChannel(channel) === false) {
            return false;
        }
        if (this._cooldownUntil > Date.now()) {
            if (this._lastCooldownLogUntil !== this._cooldownUntil) {
                log.warn(
                    "TunerDevice#%d skipped because it is cooling down for %.1f more seconds",
                    this._index, (this._cooldownUntil - Date.now()) / 1000
                );
                this._lastCooldownLogUntil = this._cooldownUntil;
            }
            return false;
        }

        return this._isDevicePathReady();
    }

    toJSON(): TunerDeviceStatus {
        return {
            index: this._index,
            name: this._config.name,
            types: this._config.types,
            command: this._command,
            pid: this.pid,
            users: this.users,
            isAvailable: this.isAvailable,
            isRemote: this.isRemote,
            isFree: this.isFree,
            isUsing: this.isUsing,
            isFault: this.isFault
        };
    }

    async kill(): Promise<void> {
        await this._kill(true);
    }

    async startStream(user: User, stream: StreamSink, channel?: ChannelItem, recoverUnavailable = false, options?: StartStreamOptions): Promise<void> {
        log.debug("TunerDevice#%d start stream for user `%s` (priority=%d)...", this._index, user.id, user.priority);
        let waitForRemoteStream = false;

        if (this._isAvailable === false) {
            if (recoverUnavailable === true && channel) {
                await this._recoverUnavailableForStart(channel);
            } else {
                throw new Error(util.format("TunerDevice#%d is not available", this._index));
            }
        }

        if (!channel && !this._stream) {
            throw new Error(util.format("TunerDevice#%d has not stream", this._index));
        }

        if (channel) {
            if (this._canUseChannel(channel) === false) {
                throw new Error(util.format("TunerDevice#%d is not supported for channel `%s`", this._index, channel.name));
            }

            if (this._stream) {
                if (channel.channel !== this._channel.channel) {
                    if (this.canStartStream(channel) === false) {
                        throw new Error(util.format("TunerDevice#%d device path is not available", this._index));
                    }
                    if (user.priority <= this.getPriority()) {
                        throw new Error(util.format("TunerDevice#%d has higher priority user", this._index));
                    }

                    await this._kill(true);
                    this._spawn(channel, user.disableMMTSDecoder === true, options, user.outputFormat, user.disableDecoder === true);
                    waitForRemoteStream = this._isRemote;
                } else if (
                    (this._canFanoutMMTSDecoder(channel) === false &&
                        this._streamUsesMMTSDecoder !== this._shouldUseMMTSDecoder(channel, user.disableMMTSDecoder === true)) ||
                    (this._isRemote &&
                        (this._remoteDecode !== this._remoteDecodeFor(user.disableDecoder === true) ||
                            this._remoteOutputFormat !== user.outputFormat))
                ) {
                    if (this._users.size !== 0) {
                        throw new Error(util.format("TunerDevice#%d has incompatible decoder mode users", this._index));
                    }
                    await this._kill(true);
                    this._spawn(channel, user.disableMMTSDecoder === true, options, user.outputFormat, user.disableDecoder === true);
                    waitForRemoteStream = this._isRemote;
                }
            } else {
                if (this.canStartStream(channel) === false) {
                    throw new Error(util.format("TunerDevice#%d device path is not available", this._index));
                }
                this._spawn(channel, user.disableMMTSDecoder === true, options, user.outputFormat, user.disableDecoder === true);
                waitForRemoteStream = this._isRemote;
            }
        }

        const streamChannel = channel || this._channel;
        if (streamChannel && this._shouldUseMMTSDecoder(streamChannel, user.disableMMTSDecoder === true) === true) {
            this._openMMTSDecoder();
        }

        log.info("TunerDevice#%d streaming to user `%s` (priority=%d)", this._index, user.id, user.priority);

        user._stream = stream;
        this._users.add(user);
        this._syncStreamFilterPriorities();
        if (stream.closed === true) {
            this.endStream(user);
        } else {
            stream.once("close", () => this.endStream(user));
        }

        if (waitForRemoteStream === true) {
            try {
                await this._waitForRemoteStream();
            } catch (err) {
                this._users.delete(user);
                if (this._process && this._exited === false && this._closing === false) {
                    await this._kill(true).catch(log.error);
                }
                this._updated();
                throw err;
            }
        }

        this._updated();
    }

    endStream(user: User, immediate = false): void {
        if (this._users.has(user) === false) {
            return;
        }

        log.debug("TunerDevice#%d end stream for user `%s` (priority=%d)...", this._index, user.id, user.priority);

        user._stream.end();
        this._users.delete(user);
        this._syncStreamFilterPriorities();

        if (this._users.size === 0) {
            if (immediate) {
                this._kill(true).catch(log.error);
            } else {
                setTimeout(() => {
                    if (this._users.size === 0 && this._process) {
                        this._kill(true).catch(log.error);
                    }
                }, 3000);
            }
        }

        log.info("TunerDevice#%d end streaming to user `%s` (priority=%d)", this._index, user.id, user.priority);

        this._updated();
    }

    detachStream(user: User): void {
        if (this._users.has(user) === false) {
            return;
        }

        log.info("TunerDevice#%d detaching user `%s` for handoff", this._index, user.id);

        this._users.delete(user);

        if (this._users.size === 0) {
            setTimeout(() => {
                if (this._users.size === 0 && this._process) {
                    this._kill(true).catch(log.error);
                }
            }, 3000);
        }

        this._updated();
    }

    async handoffAllUsersTo(device: TunerDevice, priority: number, options: TSHandoffOptions): Promise<boolean> {
        if (this.canHandoffTo(device, priority) === false) {
            return false;
        }

        // Reserve both endpoints synchronously, before the first await.
        this._handoffInProgress = true;
        device._handoffInProgress = true;
        const sourceProcess = this._process;
        const sourceChannel = this._channel;
        const users = [...this._users];
        const serviceUser = users.find(user => user.streamSetting && user.streamSetting.serviceId !== undefined);
        const handoffOptions: TSHandoffOptions = {
            ...options,
            serviceId: serviceUser ? serviceUser.streamSetting.serviceId : undefined
        };
        const oldProbe = new TSHandoffProbe(handoffOptions.serviceId);
        const newBuffer = new TSHandoffBuffer(handoffOptions);
        const tempUser: User = {
            ...users[0],
            id: `${users[0].id}:handoff`,
            priority: this.getPriority()
        };

        log.info(
            "TunerDevice#%d handoff starting to TunerDevice#%d for channel `%s` (%d users)",
            this._index,
            device.index,
            this._channel.name,
            users.length
        );

        this._handoffProbe = oldProbe;

        try {
            await device.startStream(tempUser, newBuffer as any, this._channel);
            const targetProcess = device._process;

            const switchPCR = await newBuffer.waitForSwitchPCR(() => oldProbe.lastPCR);
            if (switchPCR === null) {
                throw new Error(util.format(
                    "handoff sync timeout (oldPCR=%s, newPCR=%s, deltaMs=%s)",
                    formatPCR(oldProbe.lastPCR),
                    formatPCR(newBuffer.lastPCR),
                    formatPCRDelta(newBuffer.lastPCR, oldProbe.lastPCR)
                ));
            }

            // Acquisition and PCR synchronization yield to other requests. Never
            // commit a snapshot whose source, target or users changed meanwhile.
            if (this._process !== sourceProcess || this._exited || this._channel !== sourceChannel ||
                device._channel !== sourceChannel || !targetProcess || device._process !== targetProcess || device._exited ||
                !device._users.has(tempUser) || this._users.size !== users.length ||
                users.some(user => !this._users.has(user) || user._stream.closed)) {
                throw new Error("handoff ownership changed during synchronization");
            }
            device.detachStream(tempUser);
            const packets = newBuffer.getPacketsFromPCR(switchPCR) || [];
            const bufferedOutput = packets.length > 0 ? Buffer.concat(packets) : null;

            for (const user of users) {
                const stream = user._stream as TSFilter;
                this.detachStream(user);
                if (bufferedOutput !== null && stream.closed === false) {
                    stream.write(bufferedOutput);
                }
                await device.startStream(user, stream);
            }

            log.info("TunerDevice#%d handoff completed to TunerDevice#%d", this._index, device.index);

            return true;
        } catch (err) {
            log.warn("TunerDevice#%d handoff to TunerDevice#%d failed: %s", this._index, device.index, err.message);
            device.endStream(tempUser);
            if (device._users.size === 0 && device._process) {
                await device._kill(true).catch(log.error);
            }
            return false;
        } finally {
            this._handoffInProgress = false;
            device._handoffInProgress = false;
            if (this._handoffProbe === oldProbe) {
                this._handoffProbe = null;
            }
        }
    }

    async getRemotePrograms(query?: ProgramsQuery): Promise<apid.Program[]> {
        if (!this._isRemote) {
            throw new Error(util.format("TunerDevice#%d is not remote device", this._index));
        }

        const client = new Client();
        client.host = this.config.remoteMirakurunHost;
        client.port = this.config.remoteMirakurunPort || 40772;
        client.userAgent = "Mirakurun (Remote)";

        log.debug("TunerDevice#%d fetching remote programs from %s:%d...", this._index, client.host, client.port);

        const programs = await client.getPrograms(query);

        log.info("TunerDevice#%d fetched %d remote programs", this._index, programs.length);

        return programs;
    }

    private _spawn(
        ch: ChannelItem,
        disableMMTSDecoder = false,
        _options?: StartStreamOptions,
        outputFormat?: apid.StreamFormat,
        disableDecoder = false
    ): void {
        log.debug("TunerDevice#%d spawn...", this._index);

        if (this._process) {
            throw new Error(util.format("TunerDevice#%d has process", this._index));
        }

        let cmd: string;

        if (this._isRemote === true) {
            cmd = "node lib/remote";
            cmd += " " + this._config.remoteMirakurunHost;
            cmd += " " + (this._config.remoteMirakurunPort || 40772);
            cmd += " " + common.getTuningChannelType(ch.type);
            cmd += " " + ch.channel;
            cmd += " route=" + ch.route;
            if (this._remoteDecodeFor(disableDecoder)) {
                cmd += " decode";
            }
            if (this._config.remoteMirakurunAllowNested === true) {
                cmd += " allow-nested";
            }
            if (outputFormat) {
                cmd += " format=" + outputFormat;
            }
        } else {
            cmd = ch.type === "BS4K" && this._config.commandBS4K ? this._config.commandBS4K : this._config.command;
        }

        cmd = common.replaceCommandTemplate(cmd, {
            channel: ch.channel,
            type: common.getTuningChannelType(ch.type),
            channelType: ch.type,
            route: ch.route.toLowerCase(),
            satelite: ch.commandVars?.satellite || "", // deprecated, for backward compatibility
            space: 0, // default value for backward compatibility
            ...ch.commandVars
        });

        const parsed = common.parseCommandForSpawn(cmd);

        this._process = child_process.spawn(parsed.command, parsed.args);
        this._command = cmd;
        this._channel = ch;
        this._streamUsesMMTSDecoder = false;
        this._remoteDecode = this._isRemote ? this._remoteDecodeFor(disableDecoder) : null;
        this._remoteOutputFormat = this._isRemote ? outputFormat : undefined;
        this._lastDataAt = 0;
        this._commandFailed = false;

        if (this._config.dvbDevicePath) {
            const cat = child_process.spawn("cat", [this._config.dvbDevicePath]);

            cat.once("error", (err) => {
                log.error("TunerDevice#%d cat process error `%s` (pid=%d)", this._index, err.name, cat.pid);

                this._kill(false);
            });

            cat.once("close", (code, signal) => {
                log.debug(
                    "TunerDevice#%d cat process has closed with code=%d by signal `%s` (pid=%d)",
                    this._index, code, signal, cat.pid
                );

                if (this._exited === false) {
                    this._kill(false);
                }
            });

            this._process.once("exit", () => cat.kill("SIGKILL"));

            this._stream = cat.stdout;
        } else {
            this._stream = this._process.stdout;
            if (this._shouldUseMMTSDecoder(ch, disableMMTSDecoder) === true) {
                this._openMMTSDecoder();
            }
        }

        this._process.once("exit", () => this._exited = true);

        this._process.once("error", (err) => {
            log.fatal("TunerDevice#%d process error `%s` (pid=%d)", this._index, err.name, this._process.pid);

            this._commandFailed = true;
            ++this._fatalCount;
            if (this._fatalCount >= 3) {
                log.fatal("TunerDevice#%d has something fault! **RESTART REQUIRED** after fix it.", this._index);

                this._isFault = true;
                this._closing = true;
            }
            this._end();
            setTimeout(this._release.bind(this), this._config.dvbDevicePath ? 1000 : 100);
        });

        this._process.once("close", (code, signal) => {
            log.info(
                "TunerDevice#%d process has closed with exit code=%d by signal `%s` (pid=%d)",
                this._index, code, signal, this._process.pid
            );

            this._commandFailed = code !== 0 || signal !== null;
            this._startCooldownIfNeeded(code, signal);
            this._end();
            setTimeout(this._release.bind(this), this._config.dvbDevicePath ? 1000 : 100);
        });

        this._process.stderr.on("data", data => {
            log.debug("TunerDevice#%d > %s", this._index, data.toString().trim());
        });

        // flowing start
        this._stream.on("data", this._streamOnData.bind(this));

        this._updated();
        log.info("TunerDevice#%d process has spawned by command `%s` (pid=%d)", this._index, cmd, this._process.pid);
    }

    private _streamOnData(chunk: Buffer): void {
        this._lastDataAt = Date.now();
        if (this._canFanoutMMTSDecoder(this._channel) === true) {
            for (const user of this._users) {
                if (user.disableMMTSDecoder === true) {
                    user._stream.write(chunk);
                }
            }
            if (this._mmtsDecoderProcess && this._mmtsDecoderProcess.stdin.writable === true) {
                this._mmtsDecoderProcess.stdin.write(chunk);
            }
            return;
        }

        for (const user of this._users) {
            user._stream.write(chunk);
        }
        if (this._handoffProbe !== null) {
            this._handoffProbe.write(chunk);
        }
        if ([...this._users].some(user => user.id !== "Mirakurun:GGuide")) {
            _.gguide?.observe(this._index, this._channel, chunk);
        } else {
            _.gguide?.endObservation(this._index);
        }
    }

    private _mmtsDecoderStreamOnData(chunk: Buffer): void {
        for (const user of this._users) {
            if (user.disableMMTSDecoder !== true) {
                user._stream.write(chunk);
            }
        }
        if (this._handoffProbe !== null) {
            this._handoffProbe.write(chunk);
        }
    }

    private _openMMTSDecoder(): void {
        if (this._mmtsDecoderProcess) {
            return;
        }
        if (this._canFanoutMMTSDecoder(this._channel) === false) {
            return;
        }

        const parsedDecoder = common.parseCommandForSpawn(this._config.mmtsDecoder);
        const mmtsDecoderProcess = child_process.spawn(parsedDecoder.command, parsedDecoder.args);
        this._mmtsDecoderProcess = mmtsDecoderProcess;
        this._streamUsesMMTSDecoder = true;

        mmtsDecoderProcess.once("error", (err) => {
            log.error("TunerDevice#%d mmtsDecoder process error `%s` (pid=%d)", this._index, err.name, mmtsDecoderProcess.pid);

            this._kill(false).catch(log.error);
        });

        mmtsDecoderProcess.once("exit", () => {
            mmtsDecoderProcess.stdin.end();
        });

        mmtsDecoderProcess.once("close", (code, signal) => {
            log.debug(
                "TunerDevice#%d mmtsDecoder process has closed with code=%d by signal `%s` (pid=%d)",
                this._index, code, signal, mmtsDecoderProcess.pid
            );

            if (this._exited === false) {
                this._kill(false).catch(log.error);
            }
        });

        mmtsDecoderProcess.stdout.on("data", this._mmtsDecoderStreamOnData.bind(this));
    }

    private _shouldUseMMTSDecoder(ch: ChannelItem, disableMMTSDecoder: boolean): boolean {
        return this._canFanoutMMTSDecoder(ch) === true && disableMMTSDecoder !== true;
    }

    private async _recoverUnavailableForStart(channel: ChannelItem): Promise<void> {
        if (this._config.types.includes(channel.type) === false) {
            throw new Error(util.format("TunerDevice#%d is not supported for channel type `%s`", this._index, channel.type));
        }

        log.warn(
            "TunerDevice#%d is unavailable, but all tuners for `%s` are unavailable; forcing recovery for `%s`",
            this._index,
            channel.type,
            channel.name
        );

        if (this._isFault === true) {
            log.warn("TunerDevice#%d fault state has been cleared for forced recovery", this._index);
            this._isFault = false;
        }

        if (this._process && this._process.pid) {
            if (this._closing === true) {
                await new Promise<void>(resolve => this.once("release", resolve));
            } else {
                await this._kill(true);
            }
        }

        this._channel = null;
        this._users.clear();
        this._streamUsesMMTSDecoder = false;
        this._closing = false;
        this._exited = false;
        this._isAvailable = true;

        this._updated();
    }

    private _canFanoutMMTSDecoder(ch: ChannelItem): boolean {
        return !!ch && !this._config.dvbDevicePath && ch.type === "BS4K" && !!this._config.mmtsDecoder;
    }

    private _remoteDecodeFor(disableDecoder: boolean): boolean {
        return this._config.remoteMirakurunDecoder === true && disableDecoder !== true;
    }

    private _canUseChannel(channel: ChannelItem): boolean {
        if (this._config.types.includes(channel.type) === false) {
            return false;
        }
        if (channel.allowedTuners !== undefined && !channel.allowedTuners.includes(this._config.name)) {
            return false;
        }
        return this._config.routes === undefined || this._config.routes.length === 0 ||
            this._config.routes.includes(channel.route);
    }

    private _hasDetectedNonTsStream(): boolean {
        for (const user of this._users) {
            const filter = user._stream;
            if (filter instanceof StreamFilter &&
                (filter.detectedFormat === "tlv" || filter.isTsmf)) {
                return true;
            }
        }
        return false;
    }

    private _syncStreamFilterPriorities(): void {
        const priority = this.getPriority();
        for (const user of this._users) {
            user._stream?.syncPriorities?.(priority);
        }
    }

    private _waitForRemoteStream(): Promise<void> {
        const tunerProcess = this._process;
        const tunerStream = this._stream;

        return new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timeout);
                tunerStream.removeListener("data", onData);
                tunerProcess.removeListener("close", onClose);
                tunerProcess.removeListener("error", onError);
            };
            const onData = () => {
                cleanup();
                resolve();
            };
            const onClose = (code: number, signal: NodeJS.Signals | null) => {
                cleanup();
                reject(new TunerStartupError(util.format(
                    "TunerDevice#%d remote stream closed before first data (code=%s, signal=%s)",
                    this._index,
                    code,
                    signal
                ), code === REMOTE_EXIT_CHANNEL_UNAVAILABLE ? "channel" : "source"));
            };
            const onError = (err: Error) => {
                cleanup();
                reject(new TunerStartupError(util.format(
                    "TunerDevice#%d remote stream failed before first data (%s)",
                    this._index,
                    err.message
                ), "source"));
            };
            const timeout = setTimeout(() => {
                cleanup();
                reject(new TunerStartupError(util.format(
                    "TunerDevice#%d remote stream produced no data within %dms",
                    this._index,
                    REMOTE_STREAM_START_TIMEOUT_MS
                ), "channel"));
            }, REMOTE_STREAM_START_TIMEOUT_MS);

            tunerStream.once("data", onData);
            tunerProcess.once("close", onClose);
            tunerProcess.once("error", onError);
        });
    }

    private _isDevicePathReady(): boolean {
        const path = this.checkDevicePath;
        if (!path) {
            return true;
        }

        const ready = existsSync(path);
        if (ready !== this._lastDevicePathReady) {
            if (ready) {
                log.info("TunerDevice#%d preflight device path is available: `%s`", this._index, path);
            } else {
                log.warn("TunerDevice#%d skipped because preflight device path is missing: `%s`", this._index, path);
            }
            this._lastDevicePathReady = ready;
        }

        return ready;
    }

    private _startCooldownIfNeeded(code: number, signal: NodeJS.Signals | null): void {
        const cooldownSeconds = this._config.cooldownSeconds ?? DEFAULT_FAILURE_COOLDOWN_SECONDS;
        if (this._closing === true || cooldownSeconds <= 0) {
            return;
        }
        if (code === 0 && signal === null) {
            return;
        }

        this._cooldownUntil = Date.now() + cooldownSeconds * 1000;
        log.warn(
            "TunerDevice#%d cooling down for %d seconds after command failure",
            this._index, cooldownSeconds
        );
    }

    private _end(): void {
        _.gguide?.endObservation(this._index);
        this._isAvailable = false;

        this._stream.removeAllListeners("data");

        if (this._closing === true) {
            for (const user of this._users) {
                user._stream.end();
            }
            this._users.clear();
        }

        this._updated();
    }

    private async _kill(close: boolean): Promise<void> {
        log.debug("TunerDevice#%d kill...", this._index);

        if (!this._process || !this._process.pid) {
            throw new Error(util.format("TunerDevice#%d has not process", this._index));
        } else if (this._closing) {
            log.debug("TunerDevice#%d return because it is closing", this._index);
            return;
        }

        this._isAvailable = false;
        this._closing = close;
        this._closeMMTSDecoder();
        for (const user of this._users) {
            user._stream?.releaseTsmfCarriers?.();
        }

        this._updated();

        await new Promise<void>(resolve => {
            this.once("release", resolve);

            if (/^dvbv5-zap /.test(this._command) === true) {
                this._process.kill("SIGKILL");
            } else {
                const timer = setTimeout(() => {
                    log.warn("TunerDevice#%d will force killed because SIGTERM timed out...", this._index);
                    this._process.kill("SIGKILL");
                }, 6000);
                this._process.once("exit", () => clearTimeout(timer));

                // regular way
                this._process.kill("SIGTERM");
            }
        });
    }

    private _release(): void {
        if (this._process) {
            this._process.stderr.removeAllListeners();
            this._process.removeAllListeners();
        }
        if (this._stream) {
            this._stream.removeAllListeners();
        }
        this._closeMMTSDecoder();

        this._command = null;
        this._process = null;
        this._stream = null;

        if (this._closing === false && this._users.size !== 0) {
            if (this._commandFailed === true || this._isRemote === true) {
                log.warn("TunerDevice#%d stream failed; ending users instead of respawning on the same tuner", this._index);
                this.emit("streamFailure", this._channel);
                for (const user of this._users) {
                    user._stream.end();
                }
                this._users.clear();
            } else {
                log.warn("TunerDevice#%d respawning because request has not closed", this._index);
                ++status.errorCount.tunerDeviceRespawn;

                const users = [...this._users];
                const disableMMTSDecoder = users.length > 0 && users.every(user => user.disableMMTSDecoder === true);
                this._spawn(this._channel, disableMMTSDecoder);
                return;
            }
        }

        this._fatalCount = 0;
        this._channel = null;
        this._users.clear();
        this._streamUsesMMTSDecoder = false;

        if (this._isFault === false) {
            this._isAvailable = true;
        }

        this._closing = false;
        this._exited = false;

        this.emit("release");

        log.info("TunerDevice#%d released", this._index);

        this._updated();
    }

    private _closeMMTSDecoder(): void {
        if (!this._mmtsDecoderProcess) {
            return;
        }

        this._mmtsDecoderProcess.stdout.removeAllListeners("data");
        if (this._mmtsDecoderProcess.stdin.writable === true) {
            this._mmtsDecoderProcess.stdin.end();
        }
        this._mmtsDecoderProcess.kill("SIGTERM");
        this._mmtsDecoderProcess = null;
        this._streamUsesMMTSDecoder = false;
    }

    private _updated(): void {
        Event.emit("tuner", "update", this.toJSON());
    }
}

function formatPCR(pcr: number): string {
    return pcr === null || pcr === undefined ? "null" : pcr.toString(10);
}

function formatPCRDelta(left: number, right: number): string {
    if (left === null || left === undefined || right === null || right === undefined) {
        return "null";
    }

    return ((left - right) / 27000).toFixed(1);
}
