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
import { Writable } from "stream";
import * as apid from "../../api";
import _ from "./_";
import { channelTypes } from "./common";
import * as log from "./log";
import GGuideStore, { GGUIDE_RETENTION_MS } from "./GGuideStore";
import { createGGuideCapture, createGGuidePublication } from "./GGuideCapture";
import { enrichGGuideEpg } from "./GGuideEpg";
import StreamFilter from "./StreamFilter";
import ChannelItem from "./ChannelItem";
import type { JobItem } from "./Job";
import { dueGGuideReception, GGuideReceptionSlot } from "./GGuideReception";

const JOB_PREFIX = "gguide:";

export class GGuideError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}

export default class GGuide {
    readonly store: GGuideStore;
    readonly preserveModules: boolean;
    private readonly decodeBytes?: Buffer;
    private readonly shutdown = new AbortController();
    private active?: Promise<void>;
    private storageError?: string;
    private lastResult?: apid.GGuideCollectionResult;
    private initialized = false;
    private targetMap = new Map<string, apid.GGuideCollectionRequest>();
    private targetMapInitialized = false;
    private cleanupTimer?: NodeJS.Timeout;
    private passive = new Map<number, PassiveCapture>();
    private passiveCooldown = new Map<string, { request: apid.GGuideCollectionRequest; until: number }>();
    private pendingSaves = new Set<Promise<void>>();
    private readonly schedule: string;
    private readonly passiveEnabled: boolean;

    constructor(options: { maxBytes?: number; preserveModules?: boolean } = {}) {
        const config = _.config.server;
        this.schedule = config?.gguideSchedule ?? "auto";
        this.passiveEnabled = config?.gguidePassive !== false;
        this.decodeBytes = Buffer.from([0xb1, 0x38, 0x97, 0x43, 0xb0, 0xa9, 0xdb, 0x8f].reverse().map(value => value ^ 0xa5));
        this.preserveModules = options.preserveModules ?? config?.gguidePreserveModules ?? false;
        this.store = new GGuideStore(_.program.history,
            options.maxBytes ?? config?.gguideMaxStorageBytes ?? 256 * 1024 * 1024);
    }

    get status(): apid.GGuideStatus {
        return {
            available: this.initialized && !!this.decodeBytes && !this.shutdown.signal.aborted,
            enabled: this.store.enabled,
            keyConfigured: !!this.decodeBytes,
            collecting: this.isCollecting(),
            preserveModules: this.preserveModules,
            maxStorageBytes: this.store.maxBytes,
            retentionDays: GGUIDE_RETENTION_MS / 86400000,
            schedule: this.schedule || undefined,
            targets: this.getTargets(),
            passiveEnabled: this.passiveEnabled,
            passiveCollections: this.passive.size,
            bindingCount: this.initialized ? this.store.bindingCount : 0,
            assetCount: this.initialized ? this.store.assetCount : 0,
            lastCollection: this.lastResult || this.store.lastCollection,
            error: this.storageError || (!this.decodeBytes ? "Invalid GGuide decoder key" : undefined)
        };
    }

    async init(): Promise<void> {
        try {
            await this.store.init();
            this.initialized = true;
            this.cleanupTimer = setInterval(() => {
                this.store.prune().catch(err => log.error("GGuide retention cleanup failed: %s", err.message));
            }, 60000);
            this.cleanupTimer.unref();
            if (this.schedule) {
                _.job.addSchedule({ key: "gguide:scheduled", schedule: this.schedule === "auto" ? "* * * * *" : this.schedule,
                    job: this.collectionJob(),
                    scheduledJob: this.schedule === "auto" ? () =>
                        this.store.enabled && !this.isCollecting() && !this.hasHigherPriorityJobs() && this.getAutomaticTargets().length
                            ? this.collectionJob(true) : undefined : undefined
                });
            }
        } catch (err) {
            this.storageError = "GGuide storage unavailable; inspect the database error log";
            log.error("GGuide storage initialization failed: %s", err.message);
        }
    }

    async setEnabled(enabled: boolean): Promise<void> {
        this.assertStorage();
        await this.store.setEnabled(enabled);
        if (!enabled) {
            for (const job of _.job.jobs) {
                if (job.key.startsWith(JOB_PREFIX) && job.status !== "finished") { _.job.abort(job.id, "GGuide disabled"); }
            }
            for (const [id, session] of this.passive) { this.finishPassive(id, session); }
            await this.active?.catch(() => undefined);
        }
    }

    list(): apid.GGuideAsset[] {
        this.assertStorage();
        return enrichGGuideEpg(this.store.list().map(asset => ({ ...asset, programs: asset.programs.map(program => {
            const service = _.service.items.find(item => item.networkId === program.networkId && item.serviceId === program.serviceId);
            return { ...program, channelName: service?.name };
        }) })), _.program.itemMap.values());
    }

    bindings(): apid.GGuideBinding[] {
        this.assertStorage();
        return this.store.bindings();
    }

    async read(id: string) {
        this.assertStorage();
        return this.store.read(id);
    }

    enqueue(input: unknown): apid.JobItem {
        if (!this.store.enabled) { throw new GGuideError(409, "GGuide collection is disabled"); }
        const request = parseCollectionRequest(input);
        this.assertStorage();
        if (!this.decodeBytes || this.shutdown.signal.aborted) {
            throw new GGuideError(503, "GGuide decoder unavailable");
        }
        if (this.isCollecting()) { throw new GGuideError(409, "A GGuide collection is already queued or running"); }
        const channel = _.channel.get(request.channelType, request.channel);
        if (!channel) { throw new GGuideError(404, "Configured channel not found"); }
        const key = `${JOB_PREFIX}${request.channelType}:${request.channel}:${request.serviceId}`;
        _.job.add({
            key,
            name: `Hガイド ${request.channelType}/${request.channel} (${request.serviceId})`,
            isRerunnable: false,
            retryOnAbort: false,
            retryOnFail: false,
            fn: async ({ signal }) => {
                this.active = this.collect(request, channel, AbortSignal.any([signal, this.shutdown.signal])).then(() => undefined);
                try { await this.active; } finally { this.active = undefined; }
            }
        });
        return _.job.jobs.find(job => job.key === key && job.status !== "finished");
    }

    /** Observe raw bytes after normal fanout; never owns or extends a tuner stream. */
    observe(tunerId: number, channel: { type: apid.ChannelType; channel: string }, chunk: Buffer): void {
        if (!this.store.enabled || !this.initialized || !this.decodeBytes || !this.passiveEnabled || this.shutdown.signal.aborted || !channel) { return; }
        // Reception targets are terrestrial only. Satellite EPG streams can
        // deliver hundreds of chunks per second; never rediscover every
        // channel/service for each chunk of an ineligible stream.
        if (channel.type !== "GR" && channel.type !== "GR-ALT") {
            this.endObservation(tunerId);
            return;
        }
        let session = this.passive.get(tunerId);
        if (session && (session.request.channelType !== channel.type || session.request.channel !== channel.channel)) {
            this.endObservation(tunerId);
            session = undefined;
        }
        if (!session) {
            if (this.active || _.job?.jobs.some(job => job.key.startsWith(JOB_PREFIX) && job.status !== "finished")) { return; }
            const request = { channelType: channel.type, channel: channel.channel };
            if ([...this.passive.values()].some(item => this.sameSource(item.request, request))) { return; }
            if ([...this.passiveCooldown.values()].some(item => item.until > Date.now() && this.sameSource(item.request, request))) { return; }
            if (!this.targetMapInitialized) { this.getTargets(); }
            const target = this.targetMap.get(sourceKey(request));
            if (!target) { return; }
            const received = { ...target, ...request };
            const capture = createGGuideCapture(received, this.decodeBytes, this.preserveModules);
            session = { request: received, capture, queue: [], bytes: 0, startedAt: Date.now(), ending: false };
            const currentSession = session;
            session.stopPublishing = this.publishDuringCapture(capture, err => this.finishPassive(tunerId, currentSession, err));
            this.passive.set(tunerId, session);
            session.timer = setTimeout(() => this.endObservation(tunerId), target.durationSeconds * 1000);
            session.timer.unref();
        }
        if (session.ending) { return; }
        // Drop this observation on overload instead of applying backpressure to viewing.
        if (session.bytes + chunk.length > 4 * 1024 * 1024) {
            this.finishPassive(tunerId, session, new Error("GGuide passive input buffer exceeded"));
            return;
        }
        session.queue.push(Buffer.from(chunk));
        session.bytes += chunk.length;
        this.drainPassive(tunerId, session);
    }

    endObservation(tunerId: number): void {
        const session = this.passive.get(tunerId);
        if (!session) { return; }
        session.ending = true;
        clearTimeout(session.timer);
        this.drainPassive(tunerId, session);
    }

    async close(): Promise<void> {
        this.shutdown.abort();
        clearInterval(this.cleanupTimer);
        for (const [id, session] of this.passive) { this.finishPassive(id, session); }
        await Promise.all([...this.pendingSaves]);
        await this.active?.catch(() => undefined);
        await this.store.flush();
        this.decodeBytes?.fill(0);
    }

    private collectionJob(automatic = false): JobItem {
        return {
            key: "gguide:scheduled", name: "HGuide Getherer", isRerunnable: false,
            retryOnAbort: false, retryOnFail: false,
            readyFn: automatic ? async () => !this.hasHigherPriorityJobs() : undefined,
            fn: async ({ signal }) => {
                if (!this.store.enabled) { return; }
                if (!this.decodeBytes || this.shutdown.signal.aborted) { throw new Error("GGuide decoder unavailable"); }
                if (this.active) { throw new Error("A GGuide collection is already running"); }
                for (const [id, session] of this.passive) { this.finishPassive(id, session); }
                const yieldCapture = new AbortController();
                const watcher = automatic ? setInterval(() => {
                    if (this.hasHigherPriorityJobs()) { yieldCapture.abort(new Error("GGuide yielded to tuner jobs")); }
                }, 1000) : undefined;
                const run = async () => {
                    await Promise.all([...this.pendingSaves]);
                    await this.collectTargets(AbortSignal.any([signal, this.shutdown.signal, yieldCapture.signal]), automatic);
                };
                this.active = run();
                try { await this.active; } finally { clearInterval(watcher); this.active = undefined; }
            }
        };
    }

    private hasHigherPriorityJobs(): boolean {
        return !!_.job?.jobs.some(job => job.status !== "finished" && (
            job.key === "EPG.Gatherer" || job.key.startsWith("Service.Add.Check.") ||
            job.key.startsWith("Service.Add.Scan.") || job.key.startsWith("Service.Update.Scan.")));
    }

    private drainPassive(tunerId: number, session: PassiveCapture): void {
        if (session.immediate) { return; }
        session.immediate = setImmediate(() => {
            session.immediate = undefined;
            try {
                let bytes = 0;
                while (session.queue.length && bytes < 256 * 1024) {
                    const chunk = session.queue.shift();
                    session.bytes -= chunk.length;
                    bytes += chunk.length;
                    session.capture.carousel.write(chunk);
                }
                if (session.queue.length) { this.drainPassive(tunerId, session);
                } else if (session.ending) { this.finishPassive(tunerId, session); }
            } catch (err) { this.finishPassive(tunerId, session, err); }
        });
    }

    private finishPassive(tunerId: number, session: PassiveCapture, error?: Error): void {
        if (this.passive.get(tunerId) !== session) { return; }
        this.passive.delete(tunerId);
        clearImmediate(session.immediate);
        clearTimeout(session.timer);
        session.capture.carousel.close();
        session.queue = [];
        this.passiveCooldown.set(targetKey(session.request), { request: session.request, until: Date.now() + 6 * 60 * 60 * 1000 });
        const { materials, bindings, programIndex, receptionPlans, seen } = session.capture;
        if (error) {
            void session.stopPublishing();
            log.warn("GGuide passive observation stopped: %s", error.message);
            return;
        }
        if (!materials.size && !bindings.length && !programIndex.size && !receptionPlans.size) { void session.stopPublishing(); return; }
        const result: apid.GGuideCollectionResult = { ...session.request, startedAt: session.startedAt,
            finishedAt: Date.now(), status: "completed", assetCount: materials.size, moduleCount: seen.size };
        const save = session.stopPublishing(result)
            .then(() => { this.lastResult = result; })
            .catch(err => { log.error("GGuide passive save failed: %s", err.message); })
            .finally(() => this.pendingSaves.delete(save));
        this.pendingSaves.add(save);
    }

    private publishDuringCapture(capture: ReturnType<typeof createGGuideCapture>, onError: (error: Error) => void):
        (result?: apid.GGuideCollectionResult) => Promise<void> {
        let published = 0;
        let pending: Promise<void>;
        const snapshot = createGGuidePublication(capture);
        const publish = async (result?: apid.GGuideCollectionResult) => {
            const revision = capture.seen.size;
            const batch = snapshot();
            if (!result && !batch.materials.length && !batch.modules.size && !batch.bindings.length && !batch.programIndex.length && !batch.receptionPlans.length) {
                published = revision;
                return;
            }
            await this.store.save(batch.materials, batch.modules, result, batch.bindings, batch.programIndex, { receptionPlans: batch.receptionPlans });
            batch.commit();
            published = revision;
        };
        const timer = setInterval(() => {
            if (pending || published === capture.seen.size) { return; }
            const save = publish().catch(onError)
                .finally(() => { this.pendingSaves.delete(save); pending = undefined; });
            pending = save;
            this.pendingSaves.add(save);
        }, 2000);
        timer.unref();
        return async result => {
            clearInterval(timer);
            await pending;
            if (result) { await publish(result); }
        };
    }

    private getAutomaticTargets(now = Date.now()): GGuideReceptionSlot[] {
        const { receptionPlans, receptionProgress } = this.store.reception;
        return this.getTargets().map(request => dueGGuideReception(request,
            receptionPlans.filter(plan => this.sameSource(plan, request)),
            receptionProgress.filter(item => this.sameSource(item, request)).sort((a, b) => b.attemptedAt - a.attemptedAt), now))
            .filter((slot): slot is GGuideReceptionSlot => !!slot);
    }

    private async collectTargets(signal: AbortSignal, automatic = false): Promise<void> {
        const targets = automatic ? this.getAutomaticTargets().map(slot => slot.request) : this.getTargets();
        const running = new Map<Promise<void>, string>();
        const errors: Error[] = [];
        const capacity = (type: string) => Math.max(1, _.config.tuners.filter(tuner =>
            !tuner.isDisabled && tuner.types.includes(type as any)).length);
        while ((targets.length || running.size) && !signal.aborted) {
            while (running.size < 2) {
                // Prefer a different source type so a long local capture does not
                // postpone the remote region until the entire local scan ends.
                const eligible = (target: apid.GGuideCollectionRequest) =>
                    [...running.values()].filter(type => type === target.channelType).length < capacity(target.channelType);
                let index = targets.findIndex(target => eligible(target) && ![...running.values()].includes(target.channelType));
                if (index < 0) { index = targets.findIndex(eligible); }
                if (index < 0) { break; }
                const [target] = targets.splice(index, 1);
                const task = Promise.resolve().then(async () => {
                    signal.throwIfAborted();
                    const channel = _.channel.get(target.channelType, target.channel);
                    if (!channel) { throw new Error(`GGuide channel not configured: ${target.channelType}/${target.channel}`); }
                    if (!automatic) { await this.collect(target, channel, signal); return; }
                    // Job queueing or another source's capture may have consumed the window.
                    const slot = this.getAutomaticTargets().find(item => this.sameSource(item.request, target));
                    if (!slot) { return; }
                    const progress = { channelType: target.channelType, channel: target.channel,
                        phase: slot.phase, cycle: slot.cycle, windowStart: slot.startAt, attemptedAt: Date.now() };
                    await this.store.save([], new Map(), undefined, [], [], { receptionProgress: [progress] });
                    signal.throwIfAborted();
                    if (Date.now() >= slot.endAt) { return; }
                    const completed = await this.collect(slot.request, channel, signal, slot.endAt);
                    if (completed || slot.phase === "discovery") {
                        const learned = completed && slot.phase === "discovery" ? this.getAutomaticTargets(progress.attemptedAt)
                            .find(item => this.sameSource(item.request, target) && item.phase !== "discovery" && item.startAt <= progress.attemptedAt) : undefined;
                        const completedProgress = learned ? { ...progress, phase: learned.phase, cycle: learned.cycle, windowStart: learned.startAt } : undefined;
                        await this.store.save([], new Map(), undefined, [], [],
                            { receptionProgress: [progress, ...completedProgress ? [completedProgress] : []]
                                .map(item => ({ ...item, completedAt: Date.now() })) });
                    }
                }).catch(err => {
                    errors.push(err);
                    log.warn("HGuide capture %s/%s failed: %s", target.channelType, target.channel, err.message);
                }).finally(() => running.delete(task));
                running.set(task, target.channelType);
            }
            await Promise.race(running.keys());
        }
        await Promise.all(running.keys());
        signal.throwIfAborted();
        if (errors.length) { throw errors[0]; }
    }

    private getTargets(): apid.GGuideCollectionRequest[] {
        const targets: ChannelItem[] = [];
        this.targetMap.clear();
        for (const channel of _.channel?.items || []) {
            if (channel.type !== "GR" && channel.type !== "GR-ALT") { continue; }
            const index = targets.findIndex(previous => sameBroadcast(previous, channel));
            if (index < 0) { targets.push(channel);
            } else if (broadcastStreams(channel).length && !broadcastStreams(targets[index]).length) {
                targets[index] = channel;
            }
        }
        const requests = targets.map(channel => {
            const service = _.service?.findByChannel(channel).find(item => /^(?:Gガイド|G-?GUIDE)$/i.test(item.name.normalize("NFKC").trim()));
            return { channelType: channel.type, channel: channel.channel,
                ...service ? { serviceId: service.serviceId } : {},
                durationSeconds: _.config.server.gguideDurationSeconds ?? 1800 };
        });
        for (const channel of _.channel?.items || []) {
            if (channel.type !== "GR" && channel.type !== "GR-ALT") { continue; }
            const target = requests.find(item => {
                const canonical = _.channel.get(item.channelType, item.channel);
                return !!canonical && sameBroadcast(canonical, channel);
            });
            if (target) { this.targetMap.set(sourceKey(channel), target); }
        }
        this.targetMapInitialized = true;
        return requests;
    }

    private sameSource(first: apid.GGuideCollectionRequest, second: apid.GGuideCollectionRequest): boolean {
        const left = _.channel.get(first.channelType, first.channel);
        const right = _.channel.get(second.channelType, second.channel);
        return !!left && !!right && sameBroadcast(left, right);
    }

    private isCollecting(): boolean {
        return !!this.active || this.passive.size > 0 || !!_.job?.jobs.some(job => job.key.startsWith(JOB_PREFIX) && job.status !== "finished");
    }

    private assertStorage(): void {
        if (!this.initialized) { throw new GGuideError(503, this.storageError || "GGuide storage unavailable"); }
    }

    private async collect(request: apid.GGuideCollectionRequest, channel: { getStream: (...args: any[]) => Promise<StreamFilter> },
        signal: AbortSignal, deadline?: number): Promise<boolean> {
        const startedAt = Date.now();
        const decoded = createGGuideCapture(request, this.decodeBytes, this.preserveModules);
        const { materials, modules, bindings, programIndex, seen, carousel } = decoded;
        let filter: StreamFilter;
        let timer: NodeJS.Timeout;
        let idleTimer: NodeJS.Timeout;
        let probeTimer: NodeJS.Timeout;
        let ended = false;
        let resolveCapture: () => void;
        let rejectCapture: (err: Error) => void;
        const capture = new Promise<void>((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; });
        // Attach immediately: acquisition itself may still be pending on abort.
        capture.catch(() => undefined);
        const finish = (error?: Error) => {
            if (ended) { return; }
            ended = true;
            clearTimeout(timer);
            clearTimeout(idleTimer);
            clearTimeout(probeTimer);
            signal.removeEventListener("abort", abort);
            if (error) { rejectCapture(error); } else { resolveCapture(); }
            filter?.close();
            output.destroy();
        };
        const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error("GGuide collection aborted"));
        const output = new Writable({
            write(chunk: Buffer, encoding, callback) {
                try {
                    if (!ended) {
                        clearTimeout(idleTimer);
                        idleTimer = setTimeout(() => finish(new Error("GGuide input stalled for 30 seconds")), 30000);
                        carousel.write(chunk);
                    }
                    callback();
                } catch (err) { finish(err); callback(); }
            },
            final(callback) { finish(new Error("GGuide tuner stream ended before the capture window")); callback(); }
        });
        const stopPublishing = this.publishDuringCapture(decoded, err => finish(err));
        output.on("error", err => finish(err));
        signal.addEventListener("abort", abort, { once: true });
        try {
            signal.throwIfAborted();
            idleTimer = setTimeout(() => finish(new Error("GGuide tuner acquisition timed out")),
                Math.max(1, Math.min(30000, (deadline ?? Infinity) - Date.now())));
            const acquisition = channel.getStream({
                id: "Mirakurun:GGuide", priority: -1, disableDecoder: true, disableMMTSDecoder: true
            }, output).then(acquired => {
                if (ended || Date.now() >= deadline) { acquired.close(); finish(new Error("GGuide reception window expired")); return; }
                filter = acquired;
                filter.once("close", () => finish(new Error("GGuide tuner was closed or preempted")));
                timer = setTimeout(() => finish(), Math.max(1, Math.min(request.durationSeconds * 1000, (deadline ?? Infinity) - Date.now())));
                if (!request.serviceId) {
                    probeTimer = setTimeout(() => { if (!carousel.selectedServiceId) { finish(); } }, 10000);
                }
            });
            acquisition.catch(err => finish(err));
            await capture;
            await stopPublishing();
            signal.throwIfAborted();
            if (!request.serviceId && !carousel.selectedServiceId) { return false; }
            if (!materials.size && !bindings.length && !programIndex.size && !decoded.receptionPlans.size) {
                throw new Error("No GGuide materials or bindings received; check service, key and capture window");
            }
            const result: apid.GGuideCollectionResult = { ...request, startedAt, finishedAt: Date.now(),
                status: "completed", assetCount: materials.size, moduleCount: seen.size };
            await stopPublishing(result);
            this.lastResult = result;
            return true;
        } catch (err) {
            this.lastResult = { ...request, startedAt, finishedAt: Date.now(),
                status: signal.aborted ? "aborted" : "failed", assetCount: 0, moduleCount: seen.size,
                error: err instanceof Error ? err.message : "GGuide collection failed" };
            throw new Error(this.lastResult.error);
        } finally {
            finish(new Error("GGuide collection closed"));
            carousel.close();
            await stopPublishing();
            materials.clear();
            programIndex.clear();
            modules.clear();
        }
    }
}

export function parseCollectionRequest(input: unknown): apid.GGuideCollectionRequest {
    const value = input as apid.GGuideCollectionRequest;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => !["channelType", "channel", "serviceId", "durationSeconds"].includes(key)) ||
        !channelTypes.includes(value.channelType) || typeof value.channel !== "string" || !value.channel.length ||
        (value.serviceId !== undefined && (!Number.isInteger(value.serviceId) || value.serviceId < 1 || value.serviceId > 65535)) ||
        (value.durationSeconds !== undefined && (!Number.isInteger(value.durationSeconds) || value.durationSeconds < 1 || value.durationSeconds > 1800))) {
        throw new GGuideError(400, "Expected channelType, channel, serviceId and optional durationSeconds (1-1800)");
    }
    return { ...value, durationSeconds: value.durationSeconds ?? 1800 };
}

interface PassiveCapture {
    request: apid.GGuideCollectionRequest;
    capture: ReturnType<typeof createGGuideCapture>;
    queue: Buffer[];
    bytes: number;
    startedAt: number;
    ending: boolean;
    stopPublishing?: (result?: apid.GGuideCollectionResult) => Promise<void>;
    timer?: NodeJS.Timeout;
    immediate?: NodeJS.Immediate;
}

function targetKey(target: apid.GGuideCollectionRequest): string {
    return JSON.stringify([target.channelType, target.channel, target.serviceId]);
}

function sourceKey(source: { channelType?: apid.ChannelType; type?: apid.ChannelType; channel: string }): string {
    return `${source.channelType ?? source.type}:${source.channel}`;
}

function broadcastStreams(channel: ChannelItem): string[] {
    return [...channel.getStreams().values()]
        .filter(entry => entry.networkId > 0 && entry.streamId > 0)
        .map(entry => `${entry.networkId}:${entry.streamId}`).sort();
}

function sameBroadcast(first: ChannelItem, second: ChannelItem): boolean {
    if (first === second) { return true; }
    const left = broadcastStreams(first);
    const right = broadcastStreams(second);
    if (left.length && right.length) { return JSON.stringify(left) === JSON.stringify(right); }
    // T-prefixed terrestrial tuning names are aliases only within the same
    // regional channel type; equal RF numbers across regions are unrelated.
    const tuningName = (channel: ChannelItem) => channel.route === "TER" && /^T?\d+$/i.test(channel.channel)
        ? String(Number(channel.channel.replace(/^T/i, ""))) : channel.channel;
    return first.type === second.type && first.route === second.route && tuningName(first) === tuningName(second);
}
