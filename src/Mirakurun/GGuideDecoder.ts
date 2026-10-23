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
import { createHash, createDecipheriv } from "crypto";
import { inflateSync } from "zlib";
import { applyGGuidePAPPalette, GGuideBinding, GGuideBindingRecord, parseGGuideBindings } from "./GGuideBindings";

const MAX_MODULE_BYTES = 8 * 1024 * 1024;
const MAX_INFLATED_BYTES = 4 * 1024 * 1024;
const MAX_DECODED_MODULE_BYTES = 32 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface GGuideAsset {
    data: Buffer;
    mimeType: "image/jpeg" | "image/png";
    width: number;
    height: number;
    displayable: boolean;
    unsupportedReason?: "missing-palette";
    recordOffset: number;
    recordType: number;
    imageOffset: number;
}

export interface GGuideRecord {
    offset: number;
    type: number;
    metadataHex: string;
    logicalLength: number;
    compression: number;
    plaintextSha256: string;
    assets: GGuideAsset[];
}

export interface GGuideDecodeResult {
    moduleName?: string;
    records: GGuideRecord[];
    assets: GGuideAsset[];
    bindings: GGuideBinding[];
}

export class GGuideDecodeError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "GGuideDecodeError";
    }
}

function crc32(data: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of data) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function pngAt(data: Buffer, start: number): { asset?: Omit<GGuideAsset, "recordOffset" | "recordType" | "imageOffset">; end: number } | null {
    if (start + PNG_SIGNATURE.length > data.length || !data.subarray(start, start + PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        return null;
    }
    let offset = start + PNG_SIGNATURE.length;
    let width = 0;
    let height = 0;
    let colorType = -1;
    let sawHeader = false;
    let sawData = false;
    let sawPalette = false;
    let interlace = 0;
    let bitDepth = 0;
    let idatEnded = false;
    const idat: Buffer[] = [];
    while (offset + 12 <= data.length) {
        const length = data.readUInt32BE(offset);
        const chunkStart = offset + 8;
        const end = chunkStart + length;
        if (end + 4 > data.length) {
            return null;
        }
        const type = data.subarray(offset + 4, chunkStart).toString("ascii");
        if (data.readUInt32BE(end) !== crc32(data.subarray(offset + 4, end))) {
            return null;
        }
        if (!sawHeader) {
            if (type !== "IHDR" || length !== 13) {
                return null;
            }
            width = data.readUInt32BE(chunkStart);
            height = data.readUInt32BE(chunkStart + 4);
            bitDepth = data[chunkStart + 8];
            colorType = data[chunkStart + 9];
            interlace = data[chunkStart + 12];
            const validDepth = (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth)) ||
                (colorType === 2 && [8, 16].includes(bitDepth)) ||
                (colorType === 3 && [1, 2, 4, 8].includes(bitDepth)) ||
                (colorType === 4 && [8, 16].includes(bitDepth)) ||
                (colorType === 6 && [8, 16].includes(bitDepth));
            if (width === 0 || height === 0 || width > 16384 || height > 16384 || !validDepth || interlace > 1 ||
                data[chunkStart + 10] !== 0 || data[chunkStart + 11] !== 0) {
                return null;
            }
            sawHeader = true;
        } else if (type === "IHDR") {
            return null;
        } else if (type === "PLTE") {
            if (sawPalette || sawData || colorType === 0 || colorType === 4 || length === 0 || length % 3 !== 0 ||
                length > 768 || (colorType === 3 && length / 3 > 1 << bitDepth)) {
                return null;
            }
            sawPalette = true;
        } else if (type === "IDAT") {
            if (idatEnded) {
                return null;
            }
            sawData = true;
            idat.push(data.subarray(chunkStart, end));
        } else if (type === "IEND") {
            if (length !== 0 || !sawData) {
                return null;
            }
            let inflated: Buffer;
            try {
                inflated = inflateSync(Buffer.concat(idat), { maxOutputLength: MAX_INFLATED_BYTES });
            } catch {
                return null;
            }
            if (interlace === 0) {
                const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
                const minimumLength = height * (1 + Math.ceil(width * channels * bitDepth / 8));
                if (inflated.length !== minimumLength) {
                    return null;
                }
            }
            const displayable = colorType !== 3 || sawPalette;
            return {
                asset: {
                    data: Buffer.from(data.subarray(start, end + 4)),
                    mimeType: "image/png",
                    width,
                    height,
                    displayable,
                    ...(displayable ? {} : { unsupportedReason: "missing-palette" as const })
                },
                end: end + 4
            };
        } else if (sawData) {
            idatEnded = true;
        }
        offset = end + 4;
    }
    return null;
}

function jpegAt(data: Buffer, start: number): { asset?: Omit<GGuideAsset, "recordOffset" | "recordType" | "imageOffset">; end: number } | null {
    if (start + 4 > data.length || data[start] !== 0xff || data[start + 1] !== 0xd8 || data[start + 2] !== 0xff) {
        return null;
    }
    let offset = start + 2;
    let width = 0;
    let height = 0;
    let sawFrame = false;
    let sawScan = false;
    while (offset < data.length) {
        if (data[offset++] !== 0xff) {
            return null;
        }
        while (offset < data.length && data[offset] === 0xff) {
            offset++;
        }
        if (offset >= data.length) {
            return null;
        }
        const marker = data[offset++];
        if (marker === 0x00 || marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            return null;
        }
        if (marker === 0xd9) {
            if (!sawFrame || !sawScan) {
                return null;
            }
            return {
                asset: {
                    data: Buffer.from(data.subarray(start, offset)),
                    mimeType: "image/jpeg",
                    width,
                    height,
                    displayable: true
                },
                end: offset
            };
        }
        if (offset + 2 > data.length) {
            return null;
        }
        const length = data.readUInt16BE(offset);
        if (length < 2 || offset + length > data.length) {
            return null;
        }
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
            (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
            if (length < 8) {
                return null;
            }
            height = data.readUInt16BE(offset + 3);
            width = data.readUInt16BE(offset + 5);
            if (width === 0 || height === 0 || width > 16384 || height > 16384) {
                return null;
            }
            sawFrame = true;
        }
        offset += length;
        if (marker !== 0xda) {
            continue;
        }
        sawScan = true;
        while (offset + 1 < data.length) {
            if (data[offset++] !== 0xff) {
                continue;
            }
            const next = data[offset++];
            if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
                continue;
            }
            if (next !== 0xd9) {
                return null;
            }
            if (!sawFrame) {
                return null;
            }
            return {
                asset: {
                    data: Buffer.from(data.subarray(start, offset)),
                    mimeType: "image/jpeg",
                    width,
                    height,
                    displayable: true
                },
                end: offset
            };
        }
        return null;
    }
    return null;
}

function findAssets(data: Buffer, recordOffset: number, recordType: number): GGuideAsset[] {
    const assets: GGuideAsset[] = [];
    for (let offset = 0; offset < data.length - 2; offset++) {
        const parsed = data[offset] === 0x89 ? pngAt(data, offset) : data[offset] === 0xff && data[offset + 1] === 0xd8 ? jpegAt(data, offset) : null;
        if (!parsed?.asset) {
            continue;
        }
        assets.push({ ...parsed.asset, recordOffset, recordType, imageOffset: offset });
        offset = parsed.end - 1;
    }
    return assets;
}

function decrypt(ciphertext: Buffer, key: Buffer): Buffer {
    try {
        const desKey = Buffer.concat([key, key, key]);
        const decipher = createDecipheriv("des-ede3-ecb", desKey, null);
        decipher.setAutoPadding(false);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (error) {
        throw new GGuideDecodeError(`DES decryption failed: ${error.message}`);
    }
}

/** Decode the observed private GGuide record framing. No key discovery happens here. */
export function decodeGGuideModule(data: Buffer, key: Buffer): GGuideDecodeResult {
    if (!Buffer.isBuffer(data) || data.length > MAX_MODULE_BYTES) {
        throw new GGuideDecodeError("Module size is invalid");
    }
    if (!Buffer.isBuffer(key) || key.length !== 8) {
        throw new GGuideDecodeError("GGuide DES key must be exactly 8 bytes");
    }
    if (data.length < 28 || data.readUInt16BE(0) !== 14 || !/^[A-Z0-9]{11}$/.test(data.subarray(4, 15).toString("ascii"))) {
        return { records: [], assets: [], bindings: [] };
    }
    if (data.readUInt16BE(16) !== 0x0d7f) {
        throw new GGuideDecodeError("Invalid GGuide module prefix");
    }
    const moduleName = `${data.subarray(4, 12).toString("ascii")}.${data.subarray(12, 15).toString("ascii")}`;
    const records: GGuideRecord[] = [];
    const assets: GGuideAsset[] = [];
    const bindingRecords: GGuideBindingRecord[] = [];
    let offset = 28;
    let decodedBytes = 0;
    while (offset < data.length) {
        if (offset + 15 > data.length || data[offset] !== 0x0d || data.readUInt16BE(offset + 2) !== 0x4151) {
            throw new GGuideDecodeError(`Invalid GGuide record at ${offset}`);
        }
        const metadataLength = data[offset + 8];
        if (metadataLength > 8) {
            throw new GGuideDecodeError(`Invalid GGuide metadata length at ${offset}`);
        }
        const headerEnd = offset + 15 + metadataLength;
        if (headerEnd > data.length) {
            throw new GGuideDecodeError(`Truncated GGuide metadata at ${offset}`);
        }
        const flagsAndBlockCount = data.readUInt16BE(offset + 9 + metadataLength);
        const storedLength = (flagsAndBlockCount & 0x3fff) * 8;
        const logicalLength = data.readUInt16BE(offset + 13 + metadataLength);
        const end = headerEnd + storedLength;
        if (storedLength === 0 || logicalLength > storedLength || storedLength - logicalLength > 7 || end > data.length) {
            throw new GGuideDecodeError(`Invalid GGuide payload length at ${offset}`);
        }
        const compression = data[offset + 9 + metadataLength] >> 6;
        let plaintext = decrypt(data.subarray(headerEnd, end), key).subarray(0, logicalLength);
        if (compression !== 0) {
            if (plaintext.length < 3) {
                throw new GGuideDecodeError(`Truncated compressed GGuide payload at ${offset}`);
            }
            try {
                plaintext = inflateSync(plaintext.subarray(2), { maxOutputLength: MAX_INFLATED_BYTES });
            } catch (error) {
                throw new GGuideDecodeError(`GGuide inflation failed at ${offset}: ${error.message}`);
            }
        }
        decodedBytes += plaintext.length;
        if (decodedBytes > MAX_DECODED_MODULE_BYTES) {
            throw new GGuideDecodeError("GGuide module decoded output exceeds 32 MiB");
        }
        const recordAssets = findAssets(plaintext, offset, data[offset + 1]);
        if (data[offset + 1] === 0x56) {
            applyGGuidePAPPalette(plaintext, recordAssets);
        }
        const record: GGuideRecord = {
            offset,
            type: data[offset + 1],
            metadataHex: data.subarray(offset + 9, offset + 9 + metadataLength).toString("hex"),
            logicalLength,
            compression,
            plaintextSha256: createHash("sha256").update(plaintext).digest("hex"),
            assets: recordAssets
        };
        records.push(record);
        bindingRecords.push({ type: record.type, plaintext, assets: recordAssets });
        assets.push(...recordAssets);
        offset = end;
    }
    const bindings = parseGGuideBindings(bindingRecords);
    return { moduleName, records, assets, bindings };
}

export const GGuideDecoderLimits = { MAX_MODULE_BYTES, MAX_INFLATED_BYTES, MAX_DECODED_MODULE_BYTES };
