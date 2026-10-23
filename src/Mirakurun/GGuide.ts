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
import { dirname, join } from "path";
import * as apid from "../../api";
import _ from "./_";
import { channelTypes } from "./common";
import * as log from "./log";
import GGuideStore, { GGUIDE_RETENTION_MS } from "./GGuideStore";
import { createGGuideCapture } from "./GGuideCapture";
import TSFilter from "./TSFilter";

const JOB_PREFIX = "gguide:";

export class GGuideError extends Error {
    constructor(readonly status: number, message: string) { super(message); }
}

export default class GGuide {
    readonly store: GGuideStore;
    readonly preserveModules: boolean;
    private readonly key?: Buffer;
    private readonly shutdown = new AbortController();
    private active?: Promise<void>;
    private storageError?: string;
    private lastResult?: apid.GGuideCollectionResult;
    private initialized = false;
    private cleanupTimer?: NodeJS.Timeout;
    private passive = new Map<number, PassiveCapture>();
    private passiveCooldown = new Map<string, number>();
    private pendingSaves = new Set<Promise<void>>();
    private readonly schedule: string;
    private readonly passiveEnabled: boolean;

    constructor(options: { directory?: string; key?: string; maxBytes?: number; preserveModules?: boolean } = {}) {
        const config = _.config.server;
        this.schedule = config?.gguideSchedule ?? "20 5,11,17,23 * * *";
        this.passiveEnabled = config?.gguidePassive !== false;
        const key = options.key ?? process.env.GGUIDE_DES_KEY;
        if (typeof key === "string" && /^[a-f0-9]{16}$/i.test(key)) {
            this.key = Buffer.from(key, "hex");
        }
        this.preserveModules = options.preserveModules ?? config?.gguidePreserveModules ?? false;
        this.store = new GGuideStore(options.directory || process.env.GGUIDE_DATA_DIR_PATH ||
            join(dirname(process.env.SERVICES_DB_PATH || "/usr/local/var/db/mirakurun/services.json"), "gguide"),
            options.maxBytes ?? config?.gguideMaxStorageBytes ?? 256 * 1024 * 1024);
    }

    get status(): apid.GGuideStatus {
        return {
            available: this.initialized && !!this.key && !this.shutdown.signal.aborted,
            enabled: this.store.enabled,
            keyConfigured: !!this.key,
            collecting: this.isCollecting(),
            preserveModules: this.preserveModules,
            maxStorageBytes: this.store.maxBytes,
            retentionDays: GGUIDE_RETENTION_MS / 86400000,
            schedule: this.schedule || undefined,
            targets: this.getTargets(),
            passiveEnabled: this.passiveEnabled,
            passiveCollections: this.passive.size,
            bindingCount: this.initialized ? this.store.bindings().length : 0,
            assetCount: this.initialized ? this.store.list().length : 0,
            lastCollection: this.lastResult || this.store.lastCollection,
            error: this.storageError || (!this.key ? "Set GGUIDE_DES_KEY to a 16-digit hexadecimal DES key" : undefined)
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
                _.job.addSchedule({ key: "gguide:scheduled", schedule: this.schedule, job: {
                    key: "gguide:scheduled", name: "GGuide Gatherer", isRerunnable: false,
                    retryOnAbort: false, retryOnFail: false,
                    fn: async ({ signal }) => {
                        if (!this.store.enabled) { return; }
                        if (!this.key || this.shutdown.signal.aborted) { throw new Error("GGuide decoder unavailable"); }
                        if (this.active) { throw new Error("A GGuide collection is already running"); }
                        for (const [id, session] of this.passive) { this.finishPassive(id, session); }
                        const run = async () => {
                            await Promise.all([...this.pendingSaves]);
                            for (const target of this.getTargets()) {
                                const channel = _.channel.get(target.channelType, target.channel);
                                if (!channel) { throw new Error(`GGuide channel not configured: ${target.channelType}/${target.channel}`); }
                                await this.collect(target, channel, AbortSignal.any([signal, this.shutdown.signal]));
                            }
                        };
                        this.active = run();
                        try { await this.active; } finally { this.active = undefined; }
                    }
                } });
            }
        } catch (err) {
            this.storageError = "GGuide storage unavailable; inspect the configured data directory";
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
        return this.store.list();
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
        if (!this.key || this.shutdown.signal.aborted) {
            throw new GGuideError(503, "GGuide decoder unavailable; configure GGUIDE_DES_KEY");
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
                this.active = this.collect(request, channel, AbortSignal.any([signal, this.shutdown.signal]));
                try { await this.active; } finally { this.active = undefined; }
            }
        });
        return _.job.jobs.find(job => job.key === key && job.status !== "finished");
    }

    /** Observe raw bytes after normal fanout; never owns or extends a tuner stream. */
    observe(tunerId: number, channel: { type: apid.ChannelType; channel: string }, chunk: Buffer): void {
        if (!this.store.enabled || !this.initialized || !this.key || !this.passiveEnabled || this.shutdown.signal.aborted || !channel) { return; }
        let session = this.passive.get(tunerId);
        if (session && (session.request.channelType !== channel.type || session.request.channel !== channel.channel)) {
            this.endObservation(tunerId);
            session = undefined;
        }
        if (!session) {
            if (this.isCollecting()) { return; }
            const target = this.getTargets().find(item => item.channelType === channel.type && item.channel === channel.channel &&
                (this.passiveCooldown.get(targetKey(item)) || 0) <= Date.now());
            if (!target) { return; }
            const capture = createGGuideCapture(target, this.key, this.preserveModules);
            session = { request: target, capture, queue: [], bytes: 0, startedAt: Date.now(), ending: false };
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
        this.key?.fill(0);
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
        this.passiveCooldown.set(targetKey(session.request), Date.now() + 6 * 60 * 60 * 1000);
        const { materials, modules, bindings, seen } = session.capture;
        if (error) { log.warn("GGuide passive observation stopped: %s", error.message); return; }
        if (!materials.size && !bindings.length) { return; }
        const result: apid.GGuideCollectionResult = { ...session.request, startedAt: session.startedAt,
            finishedAt: Date.now(), status: "completed", assetCount: materials.size, moduleCount: seen.size };
        const save = this.store.save([...materials.values()], modules, result, bindings)
            .then(() => { this.lastResult = result; })
            .catch(err => { log.error("GGuide passive save failed: %s", err.message); })
            .finally(() => this.pendingSaves.delete(save));
        this.pendingSaves.add(save);
    }

    private getTargets(): apid.GGuideCollectionRequest[] {
        return (_.channel?.items || []).filter(channel => channel.type === "GR" || channel.type === "GR-ALT")
            .map(channel => ({ channelType: channel.type, channel: channel.channel,
                durationSeconds: _.config.server.gguideDurationSeconds ?? 1800 }));
    }

    private isCollecting(): boolean {
        return !!this.active || this.passive.size > 0 || !!_.job?.jobs.some(job => job.key.startsWith(JOB_PREFIX) && job.status !== "finished");
    }

    private assertStorage(): void {
        if (!this.initialized) { throw new GGuideError(503, this.storageError || "GGuide storage unavailable"); }
    }

    private async collect(request: apid.GGuideCollectionRequest, channel: { getStream: (...args: any[]) => Promise<TSFilter> }, signal: AbortSignal): Promise<void> {
        const startedAt = Date.now();
        const { materials, modules, bindings, seen, carousel } = createGGuideCapture(request, this.key, this.preserveModules);
        let filter: TSFilter;
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
        const abort = () => finish(new Error("GGuide collection aborted"));
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
        output.on("error", err => finish(err));
        signal.addEventListener("abort", abort, { once: true });
        try {
            signal.throwIfAborted();
            idleTimer = setTimeout(() => finish(new Error("GGuide tuner acquisition timed out")), 30000);
            const acquisition = channel.getStream({
                id: "Mirakurun:GGuide", priority: -1, disableDecoder: true, disableMMTSDecoder: true
            }, output).then(acquired => {
                if (ended) { acquired.close(); return; }
                filter = acquired;
                filter.once("close", () => finish(new Error("GGuide tuner was closed or preempted")));
                timer = setTimeout(() => finish(), request.durationSeconds * 1000);
                if (!request.serviceId) {
                    probeTimer = setTimeout(() => { if (!carousel.selectedServiceId) { finish(); } }, 10000);
                }
            });
            acquisition.catch(err => finish(err));
            await capture;
            signal.throwIfAborted();
            if (!request.serviceId && !carousel.selectedServiceId) { return; }
            if (!materials.size && !bindings.length) {
                throw new Error("No GGuide materials or bindings received; check service, key and capture window");
            }
            const result: apid.GGuideCollectionResult = { ...request, startedAt, finishedAt: Date.now(),
                status: "completed", assetCount: materials.size, moduleCount: seen.size };
            await this.store.save([...materials.values()], modules, result, bindings);
            this.lastResult = result;
        } catch (err) {
            this.lastResult = { ...request, startedAt, finishedAt: Date.now(),
                status: signal.aborted ? "aborted" : "failed", assetCount: 0, moduleCount: seen.size,
                error: err instanceof Error ? err.message : "GGuide collection failed" };
            throw new Error(this.lastResult.error);
        } finally {
            finish(new Error("GGuide collection closed"));
            carousel.close();
            materials.clear();
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
    timer?: NodeJS.Timeout;
    immediate?: NodeJS.Immediate;
}

function targetKey(target: apid.GGuideCollectionRequest): string {
    return JSON.stringify([target.channelType, target.channel, target.serviceId]);
}
