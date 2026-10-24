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
import { createHash } from "crypto";
import * as apid from "../../api";

const DAY = 86400000;
const DISCOVERY_INTERVAL = 6 * 3600000;
type Source = Pick<apid.GGuideCollectionRequest, "channelType" | "channel">;

export interface GGuideReceptionDefinition {
    id: string;
    windows: { preferred: boolean; day: number; startMinute: number; durationMinutes: number }[];
}

export interface GGuideReceptionPlan extends GGuideReceptionDefinition, Source {
    serviceId: number;
    receivedAt: number;
}

export interface GGuideReceptionProgress extends Source {
    phase: string;
    cycle: number;
    windowStart: number;
    attemptedAt: number;
    completedAt?: number;
}

export interface GGuideReceptionSlot {
    request: apid.GGuideCollectionRequest;
    phase: string;
    cycle: number;
    startAt: number;
    endAt: number;
}

export interface GGuideReceptionUpdate {
    receptionPlans?: GGuideReceptionPlan[];
    receptionProgress?: GGuideReceptionProgress[];
}

/** libdpro 0x7808 / 0x7b14: HIP/HSP sub-ID 0x52, six-byte prefix, three-byte slots. */
export function parseGGuideReception(type: number, metadata: Buffer, data: Buffer): GGuideReceptionDefinition[] {
    if ((type !== 0x75 && type !== 0x85) || metadata.length !== 2 || metadata[1] !== 0x52 ||
        data.length < 6 || data[4] !== 0x59 || data.length !== 6 + data[5] * 3) { return []; }
    const windows: GGuideReceptionDefinition["windows"] = [];
    for (let offset = 6; offset < data.length; offset += 3) {
        const word = data.readUInt16BE(offset);
        const startMinute = word & 0x7ff;
        const durationMinutes = data[offset + 2];
        if (startMinute >= 1440 || !durationMinutes) { return []; }
        windows.push({ preferred: !!(word & 0x8000), day: (word >> 11) & 7, startMinute, durationMinutes });
    }
    return [{ id: `${type}:${metadata.toString("hex")}:${data.subarray(0, 4).toString("hex")}`, windows }];
}

export function mergeGGuideReception(previous: GGuideReceptionUpdate, incoming: GGuideReceptionUpdate, cutoff: number): Required<GGuideReceptionUpdate> {
    const plans = new Map<string, GGuideReceptionPlan>();
    const progress = new Map<string, GGuideReceptionProgress>();
    for (const plan of [...previous.receptionPlans || [], ...incoming.receptionPlans || []]) {
        if (plan.receivedAt <= cutoff) { continue; }
        const key = JSON.stringify([plan.channelType, plan.channel, plan.serviceId, plan.id]);
        if (!plans.has(key) || plans.get(key).receivedAt <= plan.receivedAt) { plans.set(key, plan); }
    }
    for (const item of [...previous.receptionProgress || [], ...incoming.receptionProgress || []]) {
        if (item.attemptedAt <= cutoff) { continue; }
        const key = JSON.stringify([item.channelType, item.channel, item.phase]);
        if (!progress.has(key) || progress.get(key).attemptedAt <= item.attemptedAt) { progress.set(key, item); }
    }
    return { receptionPlans: [...plans.values()], receptionProgress: [...progress.values()] };
}

/** One successful reception per phase/day, preferring the marked slot and catching up in advertised backups. */
export function dueGGuideReception(request: apid.GGuideCollectionRequest, plans: GGuideReceptionPlan[],
    progress: GGuideReceptionProgress[], now: number): GGuideReceptionSlot | undefined {
    const groups = new Map<string, GGuideReceptionDefinition["windows"]>();
    for (const plan of [...plans].sort((a, b) => a.receivedAt - b.receivedAt)) {
        // Nonzero day codes have not been verified against a broadcast sample.
        const windows = plan.windows.filter(window => window.day === 0);
        if (!windows.length) { continue; }
        const preferred = windows.filter(window => window.preferred);
        const starts = [...new Set((preferred.length ? preferred : windows).map(window => window.startMinute))].sort((a, b) => a - b);
        // A duration/version update must not reopen an already completed phase.
        const phase = createHash("sha256").update(JSON.stringify(starts)).digest("hex");
        groups.set(phase, windows);
    }
    if (!groups.size) {
        const prior = progress.find(item => item.phase === "discovery");
        if (prior && now < prior.attemptedAt + (prior.completedAt === undefined ? 3600000 : DISCOVERY_INTERVAL)) { return; }
        return { request, phase: "discovery", cycle: now, startAt: now, endAt: now + request.durationSeconds * 1000 };
    }
    const midnight = Math.floor(now / DAY) * DAY;
    const slots: GGuideReceptionSlot[] = [];
    for (const [phase, windows] of groups) {
        const preferred = windows.filter(window => window.preferred);
        const anchors = (preferred.length ? preferred : windows).map(window => {
            const start = midnight + window.startMinute * 60000;
            return start > now ? start - DAY : start;
        });
        const cycle = Math.max(...anchors);
        const prior = progress.find(item => item.phase === phase);
        if (prior?.cycle === cycle && prior.completedAt !== undefined) { continue; }
        for (const window of windows) {
            for (const day of [midnight - DAY, midnight]) {
                const startAt = day + window.startMinute * 60000;
                const endAt = startAt + window.durationMinutes * 60000;
                if (startAt < cycle || startAt > now || endAt - now < 1000 || prior?.windowStart === startAt) { continue; }
                const durationSeconds = Math.min(request.durationSeconds, Math.floor((endAt - now) / 1000));
                slots.push({ request: { ...request, durationSeconds }, phase, cycle, startAt, endAt });
            }
        }
    }
    return slots.sort((a, b) => a.endAt - b.endAt)[0];
}
