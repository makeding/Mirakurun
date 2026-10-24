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
import type { GGuideStorageState, ProgramHistory } from "./ProgramHistory";

import { GGuideIndexFact, resolveGGuidePrograms } from "./GGuideProgramIndex";

export interface GGuideMaterial {
    asset: apid.GGuideAsset;
    data: Buffer;
}

export const GGUIDE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Persistent GGuide library backed by Mirakurun's existing programs.sqlite worker. */
export default class GGuideStore {
    private state: GGuideStorageState = { assets: [], modules: [], moduleReceivedAt: {}, bindings: [] };
    private ready = false;
    private writer: Promise<void> = Promise.resolve();

    constructor(private readonly history: ProgramHistory, readonly maxBytes: number) {}

    get enabled(): boolean { return this.state.enabled !== false; }
    get lastCollection(): apid.GGuideCollectionResult | undefined { return structuredClone(this.state.lastCollection); }

    get assetCount(): number {
        this.assertReady();
        const cutoff = Date.now() - GGUIDE_RETENTION_MS;
        return this.state.assets.filter(asset => asset.lastReceivedAt > cutoff).length;
    }

    get bindingCount(): number {
        this.assertReady();
        const cutoff = Date.now() - GGUIDE_RETENTION_MS;
        return this.state.bindings.filter(binding => binding.lastReceivedAt > cutoff).length;
    }

    async init(): Promise<void> {
        this.apply(await this.history.gguideOpen(this.maxBytes));
        this.ready = true;
    }

    list(): apid.GGuideAsset[] {
        this.assertReady();
        const cutoff = Date.now() - GGUIDE_RETENTION_MS;
        const bindings = this.bindings();
        const assets = resolveGGuidePrograms(structuredClone(this.state.assets.filter(asset => asset.lastReceivedAt > cutoff)),
            bindings, (this.state.programIndex || []).filter(fact => fact.receivedAt > cutoff));
        for (const asset of assets) {
            asset.advertisements = [];
            for (const binding of bindings) {
                if (binding.kind !== "nap" || !binding.members.some(member => member.assetId === asset.id)) { continue; }
                for (const member of binding.members) {
                    if (member.role !== "detailText" || !member.text) { continue; }
                    if (!asset.advertisements.some(detail => detail.objectId === binding.objectId && detail.text === member.text)) {
                        asset.advertisements.push({ objectId: binding.objectId, text: member.text });
                    }
                }
            }
        }
        return assets;
    }

    bindings(): apid.GGuideBinding[] {
        this.assertReady();
        return structuredClone(this.state.bindings.filter(binding => binding.lastReceivedAt > Date.now() - GGUIDE_RETENTION_MS));
    }

    async read(id: string): Promise<GGuideMaterial | undefined> {
        this.assertReady();
        return (await this.history.gguideRead(id)) || undefined;
    }

    async prune(now = Date.now()): Promise<void> {
        return this.exclusive(async () => this.apply(await this.history.gguidePrune(now)));
    }

    async save(materials: GGuideMaterial[], modules: Map<string, Buffer>, result: apid.GGuideCollectionResult | undefined,
        bindings: apid.GGuideBinding[] = [], programIndex: GGuideIndexFact[] = []): Promise<void> {
        return this.exclusive(async () => this.apply(await this.history.gguideSave({
            materials, modules: [...modules], result, bindings, programIndex, maxBytes: this.maxBytes
        })));
    }

    async setEnabled(enabled: boolean): Promise<void> {
        return this.exclusive(async () => this.apply(await this.history.gguideSetEnabled(enabled)));
    }

    async flush(): Promise<void> { await this.writer; }

    private exclusive(fn: () => Promise<void>): Promise<void> {
        const operation = this.writer.then(fn);
        this.writer = operation.catch(() => undefined);
        return operation;
    }

    private apply(state: GGuideStorageState): void { this.state = structuredClone(state); }
    private assertReady(): void { if (!this.ready) { throw new Error("GGuide storage unavailable"); } }
}

export function digest(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

/** OBJ12 index and media payload arrive in separate modules. */
export function mergeMembers(old: apid.GGuideBindingMember[], incoming: apid.GGuideBindingMember[]): apid.GGuideBindingMember[] {
    const members = structuredClone(old);
    for (const member of incoming) {
        const previous = members.find(item => item.role === member.role && (item.order ?? 0) === (member.order ?? 0));
        if (previous) { Object.assign(previous, member); } else { members.push(structuredClone(member)); }
    }
    return members;
}
