/*
   Copyright 2026 huggy

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0
*/
import * as apid from "../../api";
import { GGuideScheduleEntry, parseGGuideProgramSchedule } from "./GGuideProgramSchedule";

export type GGuideIndexValue =
    { kind: "program"; id: string; gcn: number; programKey?: string } |
    ({ kind: "schedule" } & GGuideScheduleEntry) |
    { kind: "media"; id: string; objectId: number } |
    { kind: "switch"; id: string } |
    { kind: "link"; id: string; from: string; to: string } |
    { kind: "channel"; id: string; gcn: number; networkId: number; serviceId: number };

export interface GGuideIndexFact {
    scope: string;
    value: GGuideIndexValue;
    receivedAt: number;
}

export function gguideScope(source: { channelType: string; channel: string; serviceId: number }): string {
    return JSON.stringify([source.channelType, source.channel, source.serviceId]);
}

/** Panasonic dpro_get_mutative_len: ff extends the single-byte length. */
function entries(data: Buffer, offset: number): Buffer[] {
    const result: Buffer[] = [];
    while (offset < data.length) {
        let length = data[offset++];
        if (length === 255) {
            if (offset >= data.length) { break; }
            length += data[offset++];
        }
        if (!length || offset + length > data.length) { break; }
        result.push(data.subarray(offset, offset + length));
        offset += length;
    }
    return result;
}

export function parseGGuideProgramIndex(type: number, metadata: Buffer, plaintext: Buffer): GGuideIndexValue[] {
    const values: GGuideIndexValue[] = [];
    if (type === 0x51) {
        values.push(...parseGGuideProgramSchedule(metadata, plaintext).map(value => ({ kind: "schedule" as const, ...value })));
    } else if (type === 0xf3) {
        for (const entry of entries(plaintext, 0)) {
            if (entry.length < 3) { continue; }
            const gcn = entry.readUInt16BE(0);
            for (let offset = 2; offset < entry.length;) {
                const token = entry[offset] & 0x7f;
                if (token === 0x40) {
                    if (offset + 5 <= entry.length) {
                        values.push({ kind: "channel", id: String(gcn), gcn,
                            networkId: entry.readUInt16BE(offset + 1), serviceId: entry.readUInt16BE(offset + 3) });
                    }
                    offset += 5;
                } else { offset += token >= 0x50 ? 2 : 1; }
            }
        }
    } else if (type === 0xdf && metadata.length >= 2) {
        const category = metadata.readUInt16BE(0) & 0x7fff;
        for (const entry of entries(plaintext, 4)) {
            if (entry.length < 6) { continue; }
            const id = entry.subarray(0, 6).toString("hex");
            if (category >= 0x4000 && entry.length >= 20) {
                const to = entry.subarray(6, 12).toString("hex");
                values.push({ kind: "link", id: [id, to].sort().join(":"), from: id, to });
            } else if (category <= 1000 && entry.length >= 11) {
                values.push({ kind: "program", id, gcn: entry.readUInt16BE(6), programKey: entry.subarray(8, 11).toString("hex") });
            } else if (category === 1304) {
                values.push({ kind: "switch", id });
            } else if (category === 1305 && entry.length >= 10) {
                const mimeEnd = 8 + entry[7];
                if (mimeEnd >= entry.length || !/^image\/G-Guide-OBJ12-(?:PNG|JPEG)$/i.test(entry.subarray(8, mimeEnd).toString("ascii"))) { continue; }
                const uriEnd = mimeEnd + 1 + entry[mimeEnd];
                if (uriEnd + 8 > entry.length) { continue; }
                const uri = /^\/OBJ12:(\d+)\/[A-Za-z0-9._-]+$/.exec(entry.subarray(mimeEnd + 1, uriEnd).toString("ascii"));
                if (uri && Number.isSafeInteger(Number(uri[1]))) { values.push({ kind: "media", id, objectId: Number(uri[1]) }); }
            }
        }
    }
    return values;
}

export function mergeGGuideIndex(previous: GGuideIndexFact[], incoming: GGuideIndexFact[], cutoff: number): GGuideIndexFact[] {
    const facts = new Map<string, GGuideIndexFact>();
    for (const fact of [...previous, ...incoming]) {
        if (fact.receivedAt <= cutoff) { continue; }
        const key = JSON.stringify([fact.scope, fact.value.kind, fact.value.id]);
        if (!facts.has(key) || facts.get(key).receivedAt <= fact.receivedAt) { facts.set(key, fact); }
    }
    return [...facts.values()];
}

/** Only the proven media -> switch -> program chain, never arbitrary graph traversal. */
export function resolveGGuidePrograms(assets: apid.GGuideAsset[], bindings: apid.GGuideBinding[], facts: GGuideIndexFact[]): apid.GGuideAsset[] {
    const scopes = new Map<string, GGuideIndexValue[]>();
    for (const fact of facts) {
        if (!scopes.has(fact.scope)) { scopes.set(fact.scope, []); }
        scopes.get(fact.scope).push(fact.value);
    }
    const matches = new Map<string, Map<string, apid.GGuideProgram>>();
    for (const [scope, values] of scopes) {
        const nodes = new Map(values.filter(value => value.kind !== "link" && value.kind !== "channel" && value.kind !== "schedule").map(value => [value.id, value]));
        const channels = new Map(values.filter((value): value is Extract<GGuideIndexValue, { kind: "channel" }> => value.kind === "channel").map(value => [value.gcn, value]));
        const schedules = new Map<string, GGuideScheduleEntry[]>();
        for (const value of values) {
            if (value.kind !== "schedule") { continue; }
            const key = `${value.gcn}:${value.programKey}`;
            if (!schedules.has(key)) { schedules.set(key, []); }
            schedules.get(key).push(value);
        }
        const links = new Map<string, Set<string>>();
        for (const value of values) {
            if (value.kind !== "link") { continue; }
            for (const [from, to] of [[value.from, value.to], [value.to, value.from]]) {
                if (!links.has(from)) { links.set(from, new Set()); }
                links.get(from).add(to);
            }
        }
        const media = new Map<number, string[]>();
        for (const node of nodes.values()) {
            if (node.kind !== "media") { continue; }
            if (!media.has(node.objectId)) { media.set(node.objectId, []); }
            media.get(node.objectId).push(node.id);
        }
        for (const binding of bindings) {
            if (binding.kind !== "obj12" || gguideScope(binding) !== scope) { continue; }
            for (const id of media.get(binding.objectId) || []) {
                for (const switchId of links.get(id) || []) {
                    if (nodes.get(switchId)?.kind !== "switch") { continue; }
                    for (const programId of links.get(switchId) || []) {
                        const program = nodes.get(programId);
                        if (program?.kind !== "program") { continue; }
                        const channel = channels.get(program.gcn);
                        if (!channel) { continue; }
                        for (const member of binding.members) {
                            if (!member.assetId) { continue; }
                            if (!matches.has(member.assetId)) { matches.set(member.assetId, new Map()); }
                            const events = schedules.get(`${program.gcn}:${program.programKey}`) || [];
                            const associations: apid.GGuideProgram[] = events.length ? events.map(event => ({
                                programGgid: program.id, networkId: channel.networkId, serviceId: channel.serviceId,
                                name: event.name, startAt: event.startAt, duration: event.duration
                            })) : [{ programGgid: program.id, networkId: channel.networkId, serviceId: channel.serviceId }];
                            for (const association of associations) {
                                matches.get(member.assetId).set(JSON.stringify([channel.networkId, channel.serviceId, program.id, association.startAt]), association);
                            }
                        }
                    }
                }
            }
        }
    }
    return assets.map(asset => ({ ...asset, programs: [...(matches.get(asset.id)?.values() || [])] }));
}
