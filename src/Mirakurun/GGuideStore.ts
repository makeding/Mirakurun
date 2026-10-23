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
import { mkdir, readFile, writeFile, rename, unlink, readdir, stat, open } from "fs/promises";
import { join } from "path";
import * as apid from "../../api";

interface Index {
    version: 1;
    assets: apid.GGuideAsset[];
    modules: string[];
    moduleReceivedAt?: Record<string, number>;
    bindings?: apid.GGuideBinding[];
    lastCollection?: apid.GGuideCollectionResult;
}

export interface GGuideMaterial {
    asset: apid.GGuideAsset;
    data: Buffer;
}

const MAX_INDEX_BYTES = 8 * 1024 * 1024;
export const GGUIDE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/;

/** Atomic publication shared by active/passive capture and retention cleanup. */
export default class GGuideStore {
    private index: Index = { version: 1, assets: [], modules: [] };
    private ready = false;
    private writer: Promise<void> = Promise.resolve();

    constructor(readonly directory: string, readonly maxBytes: number) {}

    get lastCollection(): apid.GGuideCollectionResult | undefined {
        return structuredClone(this.index.lastCollection);
    }

    async init(): Promise<void> {
        await mkdir(join(this.directory, "assets"), { recursive: true });
        await mkdir(join(this.directory, "modules"), { recursive: true });
        try {
            const filename = join(this.directory, "index.json");
            if ((await stat(filename)).size > MAX_INDEX_BYTES) {
                throw new Error("GGuide index exceeds size limit");
            }
            const index: Index = JSON.parse(await readFile(filename, "utf8"));
            if (index.version !== 1 || !Array.isArray(index.assets) || !Array.isArray(index.modules) ||
                index.assets.some(a => !HASH.test(a.id) || !Array.isArray(a.sources)) ||
                index.modules.some(id => !HASH.test(id))) {
                throw new Error("Invalid GGuide index");
            }
            this.index = index;
        } catch (err) {
            if (err.code !== "ENOENT") {
                throw err;
            }
        }
        // These directories exclusively own content-addressed blobs. Recover an
        // interrupted publication without discarding the last published index.
        for (const kind of ["assets", "modules"] as const) {
            const ids = new Set(kind === "assets" ? this.index.assets.map(a => a.id) : this.index.modules);
            for (const filename of await readdir(join(this.directory, kind))) {
                if (HASH.test(filename) && !ids.has(filename)) {
                    await unlink(join(this.directory, kind, filename));
                }
            }
            for (const id of ids) {
                await stat(join(this.directory, kind, id));
            }
        }
        await unlink(join(this.directory, "index.pending")).catch(err => {
            if (err.code !== "ENOENT") { throw err; }
        });
        this.index.bindings ??= [];
        this.index.moduleReceivedAt ??= {};
        for (const id of this.index.modules) {
            this.index.moduleReceivedAt[id] ??= (await stat(join(this.directory, "modules", id))).mtimeMs;
        }
        this.ready = true;
        await this.prune();
    }

    list(): apid.GGuideAsset[] {
        this.assertReady();
        return structuredClone(this.index.assets.filter(asset => asset.lastReceivedAt > Date.now() - GGUIDE_RETENTION_MS));
    }

    bindings(): apid.GGuideBinding[] {
        this.assertReady();
        return structuredClone((this.index.bindings || []).filter(binding => binding.lastReceivedAt > Date.now() - GGUIDE_RETENTION_MS));
    }

    async prune(now = Date.now()): Promise<void> {
        return this.exclusive(async () => {
            this.assertReady();
            const cutoff = now - GGUIDE_RETENTION_MS;
            const next = structuredClone(this.index);
            next.assets = next.assets.filter(asset => asset.lastReceivedAt > cutoff);
            for (const asset of next.assets) { asset.sources = asset.sources.filter(source => source.lastReceivedAt > cutoff); }
            next.bindings = (next.bindings || []).filter(binding => binding.lastReceivedAt > cutoff);
            next.modules = next.modules.filter(id => next.moduleReceivedAt[id] > cutoff);
            next.moduleReceivedAt = Object.fromEntries(next.modules.map(id => [id, next.moduleReceivedAt[id]]));
            const removedAssets = this.index.assets.filter(asset => !next.assets.some(a => a.id === asset.id));
            const removedModules = this.index.modules.filter(id => !next.modules.includes(id));
            await writeFile(join(this.directory, "index.pending"), JSON.stringify(next));
            await rename(join(this.directory, "index.pending"), join(this.directory, "index.json"));
            this.index = next;
            for (const asset of removedAssets) { await unlink(join(this.directory, "assets", asset.id)).catch(err => { if (err.code !== "ENOENT") { throw err; } }); }
            for (const id of removedModules) { await unlink(join(this.directory, "modules", id)).catch(err => { if (err.code !== "ENOENT") { throw err; } }); }
        });
    }

    async read(id: string): Promise<{ asset: apid.GGuideAsset; data: Buffer } | undefined> {
        this.assertReady();
        const asset = this.index.assets.find(a => a.id === id);
        if (!asset || !HASH.test(id) || asset.lastReceivedAt <= Date.now() - GGUIDE_RETENTION_MS) { return; }
        return { asset: structuredClone(asset), data: await readFile(join(this.directory, "assets", id)) };
    }

    async save(materials: GGuideMaterial[], modules: Map<string, Buffer>, result: apid.GGuideCollectionResult, bindings: apid.GGuideBinding[] = []): Promise<void> {
        return this.exclusive(() => this.publish(materials, modules, result, bindings));
    }

    async flush(): Promise<void> {
        await this.writer;
    }

    private exclusive(fn: () => Promise<void>): Promise<void> {
        const operation = this.writer.then(fn);
        this.writer = operation.catch(() => undefined);
        return operation;
    }

    private async publish(materials: GGuideMaterial[], modules: Map<string, Buffer>, result: apid.GGuideCollectionResult, bindings: apid.GGuideBinding[]): Promise<void> {
        this.assertReady();
        const next = structuredClone(this.index);
        const writes = new Map<string, Buffer>();
        for (const { asset, data } of materials) {
            if (digest(data) !== asset.id) { throw new Error("GGuide asset hash mismatch"); }
            const previous = next.assets.find(a => a.id === asset.id);
            if (previous) {
                previous.lastReceivedAt = Math.max(previous.lastReceivedAt, asset.lastReceivedAt);
                for (const source of asset.sources) {
                    const old = previous.sources.find(s => sourceIdentity(s) === sourceIdentity(source));
                    if (old) { old.lastReceivedAt = Math.max(old.lastReceivedAt, source.lastReceivedAt); } else { previous.sources.push(source); }
                }
            } else {
                next.assets.push(asset);
                writes.set(join(this.directory, "assets", asset.id), data);
            }
        }
        for (const [id, data] of modules) {
            if (digest(data) !== id) { throw new Error("GGuide module hash mismatch"); }
            if (!next.modules.includes(id)) {
                next.modules.push(id);
                writes.set(join(this.directory, "modules", id), data);
            }
        }
        for (const id of modules.keys()) { next.moduleReceivedAt[id] = result.finishedAt; }
        for (const binding of bindings) {
            const previous = next.bindings.find(item => item.id === binding.id);
            if (!previous) { next.bindings.push(structuredClone(binding)); continue; }
            const members = binding.kind === "pap" ? structuredClone(binding.members) : mergeMembers(previous.members, binding.members);
            Object.assign(previous, binding, { firstReceivedAt: Math.min(previous.firstReceivedAt, binding.firstReceivedAt), members });
        }
        next.lastCollection = result;
        const json = JSON.stringify(next);
        const indexBytes = Buffer.byteLength(json);
        if (indexBytes > MAX_INDEX_BYTES) { throw new Error("GGuide metadata budget exhausted"); }
        let bytes = indexBytes * 2;
        for (const kind of ["assets", "modules"]) {
            for (const filename of await readdir(join(this.directory, kind))) {
                bytes += (await stat(join(this.directory, kind, filename))).size;
            }
        }
        for (const data of writes.values()) { bytes += data.length; }
        if (bytes > this.maxBytes) { throw new Error("GGuide storage budget exhausted"); }
        const created: string[] = [];
        const pending = join(this.directory, "index.pending");
        try {
            for (const [filename, data] of writes) {
                const file = await open(filename, "wx");
                created.push(filename);
                try { await file.writeFile(data); } finally { await file.close(); }
            }
            await writeFile(pending, json);
            await rename(pending, join(this.directory, "index.json"));
            this.index = next;
        } catch (err) {
            for (const filename of created) { await unlink(filename).catch(() => undefined); }
            throw err;
        } finally {
            await unlink(pending).catch(err => { if (err.code !== "ENOENT") { throw err; } });
        }
    }

    private assertReady(): void {
        if (!this.ready) { throw new Error("GGuide storage unavailable"); }
    }
}

export function digest(data: Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

function sourceIdentity(source: apid.GGuideSource): string {
    return JSON.stringify([source.channelType, source.channel, source.serviceId,
        source.pid, source.moduleHash, source.recordOffset, source.imageOffset]);
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
