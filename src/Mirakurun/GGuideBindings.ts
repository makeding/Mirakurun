/*
   Copyright 2026 huggy

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0
*/
import { createHash } from "crypto";

export type GGuideBindingKind = "nap" | "pap" | "obj12";
export type GGuideBindingRole = "top" | "detailImage" | "detailText" | "topAnimation" | "frame" | "media";

export interface GGuideBindingMember {
    role: GGuideBindingRole;
    /** Receiver object identity for a NAP member received in a separate module. */
    objectId?: number;
    assetId?: string;
    uri?: string;
    mimeType?: string;
    imageOffset?: number;
    order?: number;
}

export interface GGuideBinding {
    kind: GGuideBindingKind;
    objectId: number;
    members: GGuideBindingMember[];
    startRaw?: number;
    endRaw?: number;
    rawControls?: string;
}

export interface GGuideBindingAsset {
    data: Buffer;
    mimeType: "image/jpeg" | "image/png";
    imageOffset: number;
    displayable: boolean;
    unsupportedReason?: "missing-palette";
}

export interface GGuideBindingRecord {
    type: number;
    plaintext: Buffer;
    assets: GGuideBindingAsset[];
}

interface Tlv { tag: number; payload: Buffer; start: number; end: number; }

function tlvs(data: Buffer, offset: number, end = data.length): Tlv[] {
    const result: Tlv[] = [];
    while (offset + 4 <= end) {
        const length = data.readUInt16BE(offset);
        if (length === 0) { break; }
        if (length < 2 || offset + 2 + length > end) { return result; }
        result.push({ tag: data.readUInt16BE(offset + 2), payload: data.subarray(offset + 4, offset + 2 + length), start: offset, end: offset + 2 + length });
        offset += 2 + length;
    }
    return result;
}

function assetId(asset: GGuideBindingAsset): string { return createHash("sha256").update(asset.data).digest("hex"); }

function pngPalette(data: Buffer, palette: Buffer): Buffer | undefined {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!data.subarray(0, 8).equals(sig) || palette.length === 0 || palette.length > 768 || palette.length % 3 !== 0) { return; }
    let offset = 8;
    while (offset + 12 <= data.length) {
        const length = data.readUInt32BE(offset);
        const type = data.subarray(offset + 4, offset + 8).toString("ascii");
        const end = offset + 12 + length;
        if (end > data.length) { return; }
        if (type === "PLTE") { return data; }
        if (type === "IDAT") {
            const chunk = Buffer.alloc(12 + palette.length);
            chunk.writeUInt32BE(palette.length, 0);
            chunk.write("PLTE", 4, 4, "ascii");
            palette.copy(chunk, 8);
            chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + palette.length)), 8 + palette.length);
            return Buffer.concat([data.subarray(0, offset), chunk, data.subarray(offset)]);
        }
        offset = end;
    }
    return;
}

function crc32(data: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) { crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** Adds the receiver-provided PAP RGB palette to otherwise valid indexed PNG frames. */
export function applyGGuidePAPPalette(plaintext: Buffer, assets: GGuideBindingAsset[]): void {
    const top = tlvs(plaintext, 5);
    const visual = top.find(item => item.tag === 2);
    if (!visual || visual.payload.length < 3 || visual.payload.readUInt16BE(0) !== 8 || visual.payload[2] !== 0xff) { return; }
    const children = tlvs(visual.payload, 3);
    const palette = children.find(item => item.tag === 1)?.payload;
    if (!palette || palette.length < 4) { return; }
    const count = palette.readUInt32BE(0);
    if (count === 0 || count > 256 || palette.length !== 4 + count * 3) { return; }
    for (const child of children.filter(item => item.tag === 3 || item.tag === 4 || item.tag === 6)) {
        for (const asset of assets.filter(item => item.mimeType === "image/png" && item.imageOffset >= visual.start + 4 + child.start && item.imageOffset < visual.start + 4 + child.end)) {
            const patched = pngPalette(asset.data, palette.subarray(4));
            if (patched) {
                asset.data = patched;
                asset.displayable = true;
                delete asset.unsupportedReason;
            }
        }
    }
}

function parseNAP(record: GGuideBindingRecord): GGuideBinding | undefined {
    const entries = tlvs(record.plaintext, 5);
    const identity = entries.find(item => item.tag === 1);
    if (!identity || identity.payload.length !== 18) { return; }
    const objectId = identity.payload.readUInt32BE(0);
    const members: GGuideBindingMember[] = [];
    const urls = /https?:\/\/[^\x00\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f\s]+/g;
    const text = record.plaintext.toString("latin1");
    for (const match of text.matchAll(urls)) {
        const uri = match[0];
        const role = /net_top_img1\.jpg$/.test(uri) ? "top" : /net_detail_img\.jpg$/.test(uri) ? "detailImage" :
            /net_detail_txt\.gss$/.test(uri) ? "detailText" : /netani_\d+\.zip$/.test(uri) ? "topAnimation" : undefined;
        if (!role) { continue; }
        // The five retained NAP/f8 package pairs establish this numbering for
        // NAP's separately delivered 0xf8 members. It is an object reference
        // rather than a role inferred from image dimensions.
        if (role === "top") {
            members.push({ role, uri, objectId: objectId * 10, order: 0 });
        } else if (role === "detailImage") {
            members.push({ role, uri, objectId: objectId * 10 + 3 });
        } else if (role === "detailText") {
            members.push({ role, uri, objectId: objectId * 10 + 2 });
        } else {
            // An animation archive has two separately broadcast JPEG frames.
            members.push({ role, uri });
            members.push({ role: "top", objectId: objectId * 10, order: 0 });
            members.push({ role: "top", objectId: objectId * 10 + 1, order: 1 });
        }
    }
    if (members.length === 0) { return; }
    return { kind: "nap", objectId, members, startRaw: identity.payload.readUInt32BE(4), endRaw: identity.payload.readUInt32BE(8), rawControls: identity.payload.subarray(12).toString("hex") };
}

function parsePAP(record: GGuideBindingRecord): GGuideBinding | undefined {
    const entries = tlvs(record.plaintext, 5);
    const identity = entries.find(item => item.tag === 1);
    if (!identity || identity.payload.length < 16) { return; }
    const members = record.assets.filter(asset => asset.mimeType === "image/png").sort((a, b) => a.imageOffset - b.imageOffset)
        .map((asset, order) => ({ role: "frame" as const, assetId: assetId(asset), mimeType: asset.mimeType, imageOffset: asset.imageOffset, order }));
    if (members.length === 0) { return; }
    // PAP tag 1 has a four-byte opaque field between its ID and observed
    // validity values.  Keep that field raw rather than treating it as time.
    return { kind: "pap", objectId: identity.payload.readUInt32BE(0), members, startRaw: identity.payload.readUInt32BE(8), endRaw: identity.payload.readUInt32BE(12), rawControls: identity.payload.subarray(4, 8).toString("hex") + identity.payload.subarray(16).toString("hex") };
}

function parseMM(record: GGuideBindingRecord): GGuideBinding | undefined {
    const entries = tlvs(record.plaintext, 3);
    const identity = entries.find(item => item.tag === 1);
    if (!identity || identity.payload.length < 4) { return; }
    const objectId = identity.payload.readUInt32BE(0);
    const members = record.assets.map((asset, order) => ({ role: "media" as const, assetId: assetId(asset), mimeType: asset.mimeType, imageOffset: asset.imageOffset, order }));
    if (members.length === 0) { return; }
    return { kind: "obj12", objectId, members, rawControls: identity.payload.subarray(4).toString("hex") };
}

/**
 * Parses local NAP material.  The observed f8 form identifies the material
 * with tag 1's object ID, its end validity with tag 2, and its receiver file
 * name in tag 3.  Only the four retained names plus matching object slots are
 * assigned a placement role; all other f8 records remain unbound.  f8 is NAP
 * material, not OBJ12: its parent ad is its object ID divided by ten.
 */
function parseF8(record: GGuideBindingRecord): GGuideBinding | undefined {
    const entries = tlvs(record.plaintext, 3);
    const identity = entries.find(item => item.tag === 1);
    const validity = entries.find(item => item.tag === 2);
    if (!identity || identity.payload.length < 8 || !validity || validity.payload.length < 4) { return; }
    const objectId = identity.payload.readUInt32BE(0);
    const slot = objectId % 10;
    const text = record.plaintext.toString("latin1");
    const name = /(?:^|[^A-Za-z0-9_.-])(top1\.jpg|top2\.jpg|detail\.jpg|detail\.gss)(?:\x00|$)/.exec(text)?.[1];
    const role = name === "top1.jpg" && slot === 0 ? "top" :
        name === "top2.jpg" && slot === 1 ? "top" :
            name === "detail.jpg" && slot === 3 ? "detailImage" :
                name === "detail.gss" && slot === 2 ? "detailText" : undefined;
    if (!role) { return; }
    const members: GGuideBindingMember[] = record.assets.map((asset, order) => ({
        role, objectId, assetId: assetId(asset), mimeType: asset.mimeType, imageOffset: asset.imageOffset,
        order: role === "top" ? slot : order
    }));
    // detail.gss is received local material as well but is not an image asset.
    if (members.length === 0) {
        members.push(role === "top" ? { role, objectId, order: slot } : { role, objectId });
    }
    return { kind: "nap", objectId: Math.floor(objectId / 10), members, startRaw: identity.payload.readUInt32BE(4),
        endRaw: validity.payload.readUInt32BE(0), rawControls: identity.payload.subarray(8).toString("hex") };
}

function parseOBJ12Index(record: GGuideBindingRecord): GGuideBinding[] {
    const result: GGuideBinding[] = [];
    const text = record.plaintext.toString("latin1");
    const re = /Image\/G-Guide-OBJ12-(PNG|JPEG)/g;
    for (const match of text.matchAll(re)) {
        const at = match.index || 0;
        const uriLengthOffset = at + match[0].length;
        // OBJ12 index entries use a one-byte entry length before the u16 tag:
        // rawStart(4), length(1), tag(2), objectId(4), MIME length(1).
        if (at < 12 || uriLengthOffset >= record.plaintext.length) { continue; }
        const uriLength = record.plaintext[uriLengthOffset];
        const uriStart = uriLengthOffset + 1;
        const uriEnd = uriStart + uriLength;
        if (uriLength === 0 || uriEnd + 4 > record.plaintext.length) { continue; }
        const uri = record.plaintext.subarray(uriStart, uriEnd).toString("ascii");
        const uriMatch = /^\/OBJ12:(\d+)\/[A-Za-z0-9._-]+$/.exec(uri);
        if (!uriMatch) { continue; }
        const objectId = Number(uriMatch[1]);
        // The surrounding df entry fields are not yet fully delimited.  The
        // index URI/MIME/object identity is proven; do not mislabel adjacent
        // opaque u32 values as validity timestamps.
        result.push({ kind: "obj12", objectId,
            members: [{ role: "media", uri, mimeType: `Image/G-Guide-OBJ12-${match[1]}` }] });
    }
    return result;
}

export function parseGGuideBindings(records: GGuideBindingRecord[]): GGuideBinding[] {
    const bindings: GGuideBinding[] = [];
    for (const record of records) {
        const binding = record.type === 0xf9 ? parseNAP(record) : record.type === 0x56 ? parsePAP(record) : record.type === 0xf5 ? parseMM(record) : record.type === 0xf8 ? parseF8(record) : undefined;
        if (binding) { bindings.push(binding); }
        if (record.type === 0xdf) { bindings.push(...parseOBJ12Index(record)); }
    }
    return bindings;
}
