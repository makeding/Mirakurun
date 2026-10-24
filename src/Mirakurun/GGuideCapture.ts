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
import * as apid from "../../api";
import { GGuideMaterial, digest } from "./GGuideStore";
import { decodeGGuideModule } from "./GGuideDecoder";
import { GGuideCarousel } from "./GGuideCarousel";

import { GGuideIndexFact, gguideScope } from "./GGuideProgramIndex";

const MAX_STAGED_BYTES = 64 * 1024 * 1024;

/** Bounded decoder staging shared by scheduled, manual and passive reception. */
export function createGGuideCapture(request: apid.GGuideCollectionRequest, payload: Buffer, preserveModules: boolean) {
    const context = Buffer.from(payload.map((value, index) => value ^ ((0x39 + index * 17) & 0xff)));
    const materials = new Map<string, GGuideMaterial>();
    const modules = new Map<string, Buffer>();
    const bindings: apid.GGuideBinding[] = [];
    const seen = new Set<string>();
    const programIndex = new Map<string, GGuideIndexFact>();
    let stagedBytes = 0;
    const carousel = new GGuideCarousel({ serviceId: request.serviceId, onModule: module => {
        const moduleHash = digest(module.data);
        if (seen.has(moduleHash)) { return; }
        seen.add(moduleHash);
        // Bound the identity set as well as retained payload buffers.
        if (seen.size > 8192) { throw new Error("GGuide module count limit exceeded"); }
        const decoded = decodeGGuideModule(module.data, context);
        const receivedAt = Date.now();
        const scope = gguideScope({ ...request, serviceId: module.serviceId });
        for (const value of decoded.programIndex) {
            const id = JSON.stringify([scope, value.kind, value.id]);
            const fact = { scope, value, receivedAt };
            const prior = programIndex.get(id);
            stagedBytes += Buffer.byteLength(JSON.stringify(fact)) - (prior ? Buffer.byteLength(JSON.stringify(prior)) : 0);
            programIndex.set(id, fact);
        }
        for (const binding of decoded.bindings) {
            const id = digest(Buffer.from(JSON.stringify([request.channelType, request.channel, module.serviceId, binding.kind, binding.objectId])));
            stagedBytes += Buffer.byteLength(JSON.stringify(binding));
            bindings.push({ ...binding, id, channelType: request.channelType, channel: request.channel,
                serviceId: module.serviceId, firstReceivedAt: receivedAt, lastReceivedAt: receivedAt });
        }
        for (const image of decoded.assets) {
            const id = digest(image.data);
            const source: apid.GGuideSource = {
                channelType: request.channelType, channel: request.channel, serviceId: module.serviceId,
                pid: module.pid, downloadId: module.downloadId, moduleId: module.moduleId,
                moduleVersion: module.moduleVersion, moduleHash, moduleName: decoded.moduleName,
                recordOffset: image.recordOffset, imageOffset: image.imageOffset, recordType: image.recordType,
                metadataHex: decoded.records.find(record => record.offset === image.recordOffset)?.metadataHex || "",
                firstReceivedAt: receivedAt, lastReceivedAt: receivedAt
            };
            const existing = materials.get(id);
            if (existing) {
                existing.asset.sources.push(source);
                existing.asset.lastReceivedAt = receivedAt;
            } else {
                stagedBytes += image.data.length;
                materials.set(id, { data: image.data, asset: {
                    id, mimeType: image.mimeType, width: image.width, height: image.height,
                    size: image.data.length, displayable: image.displayable,
                    unsupportedReason: image.unsupportedReason, displayEligibility: "unknown",
                    firstReceivedAt: receivedAt, lastReceivedAt: receivedAt, sources: [source]
                } });
            }
        }
        if (preserveModules && decoded.records.length > 0) {
            modules.set(moduleHash, module.data);
            stagedBytes += module.data.length;
        }
        if (stagedBytes > MAX_STAGED_BYTES) { throw new Error("GGuide collection memory budget exhausted"); }
    } });
    return { materials, modules, bindings, programIndex, seen, carousel };
}

/** Acknowledge only a committed snapshot; reception may advance during SQLite I/O. */
export function createGGuidePublication(capture: ReturnType<typeof createGGuideCapture>) {
    const publishedMaterials = new Map<string, { sources: number; receivedAt: number }>();
    const publishedModules = new Set<string>();
    const publishedFacts = new Map<string, GGuideIndexFact>();
    let publishedBindings = 0;
    return () => {
        const versions = new Map<string, { sources: number; receivedAt: number }>();
        const materials: GGuideMaterial[] = [];
        for (const [id, item] of capture.materials) {
            const version = { sources: item.asset.sources.length, receivedAt: item.asset.lastReceivedAt };
            const prior = publishedMaterials.get(id);
            if (prior?.sources === version.sources && prior?.receivedAt === version.receivedAt) { continue; }
            versions.set(id, version);
            materials.push({ data: item.data, asset: structuredClone(item.asset) });
        }
        const modules = new Map([...capture.modules].filter(([id]) => !publishedModules.has(id)));
        const bindingCount = capture.bindings.length;
        const bindings = capture.bindings.slice(publishedBindings, bindingCount);
        const facts = [...capture.programIndex].filter(([id, fact]) => publishedFacts.get(id) !== fact);
        return {
            materials, modules, bindings, programIndex: facts.map(([, fact]) => fact),
            commit: () => {
                for (const [id, version] of versions) { publishedMaterials.set(id, version); }
                for (const id of modules.keys()) { publishedModules.add(id); }
                for (const [id, fact] of facts) { publishedFacts.set(id, fact); }
                publishedBindings = bindingCount;
            }
        };
    };
}
