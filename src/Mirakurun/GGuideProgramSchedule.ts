/*
   Copyright 2026 huggy

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0
*/
import { TsChar } from "@chinachu/aribts";

export interface GGuideScheduleEntry {
    id: string;
    gcn: number;
    programKey: string;
    name?: string;
    startAt: number;
    duration?: number;
}

/** Verified against ggsvr 0x15ba8; do not interpret the compact descriptors as EIT. */
export function parseGGuideProgramSchedule(metadata: Buffer, data: Buffer): GGuideScheduleEntry[] {
    if (metadata.length < 4) { return []; }
    const gcn = metadata.readUInt16BE(0);
    const mjd = (metadata.readUInt16BE(2) - 0x4213) & 0xffff;
    const midnight = (mjd - 40587) * 86400000 - 9 * 3600000;
    const entries: Buffer[] = [];
    for (let offset = 0; offset < data.length;) {
        let length = 0;
        let byte: number;
        do {
            if (offset >= data.length) { return []; }
            byte = data[offset++];
            length += byte;
        } while (byte === 0xff);
        if (!length) { break; }
        if (length < 8 || offset + length > data.length) { return []; }
        const entry = data.subarray(offset, offset + length);
        if (8 + entry[7] > entry.length) { return []; }
        entries.push(entry);
        offset += length;
    }
    const result: GGuideScheduleEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const programKey = entry.subarray(4, 7).toString("hex");
        // The terminal boundary carries a start minute but no program.
        if (programKey === "ffffff") { continue; }
        const startAt = midnight + entry.readInt16BE(0) * 60000;
        const next = entries[i + 1];
        const duration = next ? ((next.readUInt16BE(0) - entry.readUInt16BE(0)) & 0xffff) * 60000 : undefined;
        const name = new TsChar(entry.subarray(8, 8 + entry[7])).decode() || undefined;
        result.push({ id: `${gcn}:${programKey}:${startAt}`, gcn, programKey, name, startAt, duration });
    }
    return result;
}
