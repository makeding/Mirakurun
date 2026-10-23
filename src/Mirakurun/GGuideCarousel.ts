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
import { TsStreamLite } from "@chinachu/aribts";

export interface GGuideModule {
    pid: number;
    downloadId: number;
    moduleId: number;
    moduleVersion: number;
    data: Buffer;
}

export interface GGuideCarouselOptions {
    serviceId: number;
    onModule: (module: GGuideModule) => void;
    maxModuleBytes?: number;
    maxBufferedBytes?: number;
}

export interface GGuideCarouselStats {
    packets: number;
    syncLoss: number;
    malformed: number;
    completed: number;
    discarded: number;
    bufferedBytes: number;
}

interface DownloadModule {
    pid: number;
    downloadId: number;
    moduleId: number;
    moduleVersion: number;
    blockSize: number;
    data: Buffer;
    blocks: Set<number>;
}

const DEFAULT_MAX_MODULE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
const PACKET_SIZE = 188;

export class GGuideCarousel {
    readonly stats: GGuideCarouselStats = { packets: 0, syncLoss: 0, malformed: 0, completed: 0, discarded: 0, bufferedBytes: 0 };

    private _parser = new TsStreamLite();
    private _pending = Buffer.alloc(0);
    private _pmtPid = -1;
    private _dataPids = new Set<number>();
    private _modules = new Map<string, DownloadModule>();
    private _closed = false;
    private _maxModuleBytes: number;
    private _maxBufferedBytes: number;

    constructor(private _options: GGuideCarouselOptions) {
        if (!Number.isInteger(_options.serviceId) || _options.serviceId < 1 || _options.serviceId > 0xffff) {
            throw new Error("GGuide service ID is invalid");
        }
        this._maxModuleBytes = _options.maxModuleBytes || DEFAULT_MAX_MODULE_BYTES;
        this._maxBufferedBytes = _options.maxBufferedBytes || DEFAULT_MAX_BUFFERED_BYTES;
        if (!Number.isSafeInteger(this._maxModuleBytes) || this._maxModuleBytes < 1 ||
            !Number.isSafeInteger(this._maxBufferedBytes) || this._maxBufferedBytes < this._maxModuleBytes) {
            throw new Error("GGuide carousel limits are invalid");
        }
        this._parser.on("pat", (_pid: number, pat: any) => this._onPat(pat));
        this._parser.on("pmt", (pid: number, pmt: any) => this._onPmt(pid, pmt));
        this._parser.on("dsmcc", (pid: number, section: any) => this._onDsmcc(pid, section));
        this._parser.on("drop", () => {
            this.stats.malformed++;
            this._discardAll();
        });
    }

    write(chunk: Buffer): void {
        if (this._closed) {
            throw new Error("GGuide carousel is closed");
        }
        if (!Buffer.isBuffer(chunk)) {
            throw new TypeError("GGuide carousel input must be a Buffer");
        }
        this._pending = this._pending.length === 0 ? chunk : Buffer.concat([this._pending, chunk]);
        let offset = 0;
        while (this._pending.length - offset >= PACKET_SIZE) {
            if (this._pending[offset] !== 0x47) {
                offset++;
                this.stats.syncLoss++;
                continue;
            }
            const packet = this._pending.subarray(offset, offset + PACKET_SIZE);
            const pid = ((packet[1] & 0x1f) << 8) | packet[2];
            if (pid === 0 || pid === this._pmtPid || this._dataPids.has(pid)) {
                this._parser.write([packet]);
                this.stats.packets++;
            }
            offset += PACKET_SIZE;
        }
        this._pending = Buffer.from(this._pending.subarray(offset));
    }

    close(): void {
        if (this._closed) {
            return;
        }
        this._closed = true;
        this.stats.discarded += this._modules.size;
        this._modules.clear();
        this.stats.bufferedBytes = 0;
        this._pending = Buffer.alloc(0);
        this._dataPids.clear();
    }

    getStats(): GGuideCarouselStats {
        return { ...this.stats };
    }

    private _moduleKey(pid: number, downloadId: number, moduleId: number, moduleVersion: number): string {
        return `${pid}:${downloadId}:${moduleId}:${moduleVersion}`;
    }

    private _discardModule(key: string): void {
        const module = this._modules.get(key);
        if (!module) {
            return;
        }
        this.stats.bufferedBytes -= module.data.length;
        this._modules.delete(key);
        this.stats.discarded++;
    }

    private _onPat(pat: any): void {
        if (pat.current_next_indicator !== 1) {
            return;
        }
        const program = pat.programs?.find((item: any) => item.program_number === this._options.serviceId);
        if (!program || program.program_map_PID === this._pmtPid) {
            return;
        }
        this._pmtPid = program.program_map_PID;
        this._dataPids.clear();
        this._discardAll();
    }

    private _onPmt(pid: number, pmt: any): void {
        if (pmt.current_next_indicator !== 1 || pid !== this._pmtPid || pmt.program_number !== this._options.serviceId) {
            return;
        }
        const nextPids = new Set<number>();
        for (const stream of pmt.streams || []) {
            if (stream.stream_type !== 0x0d || !Array.isArray(stream.ES_info)) {
                continue;
            }
            const isGGuide = stream.ES_info.some((descriptor: any) =>
                descriptor.descriptor_tag === 0xfd && Buffer.isBuffer(descriptor._raw) &&
                descriptor._raw.length >= 4 && descriptor._raw.readUInt16BE(2) === 0x000a);
            if (isGGuide) {
                nextPids.add(stream.elementary_PID);
            }
        }
        for (const key of this._modules.keys()) {
            const module = this._modules.get(key);
            if (module && !nextPids.has(module.pid)) {
                this._discardModule(key);
            }
        }
        this._dataPids = nextPids;
    }

    private _onDsmcc(pid: number, section: any): void {
        if (!this._dataPids.has(pid) || section.current_next_indicator !== 1) {
            return;
        }
        const message = section.message;
        if (!message || message.protocolDiscriminator !== 0x11 || message.dsmccType !== 3) {
            return;
        }
        if (section.table_id === 0x3b && message.messageId === 0x1002) {
            this._onDii(pid, message);
        } else if (section.table_id === 0x3c && message.messageId === 0x1003) {
            this._onDdb(pid, message);
        }
    }

    private _onDii(pid: number, message: any): void {
        if (!Array.isArray(message.modules) || message.modules.length > 1024 || !Number.isInteger(message.downloadId) ||
            !Number.isInteger(message.blockSize) || message.blockSize < 1 || message.blockSize > 4096) {
            this.stats.malformed++;
            return;
        }
        const inventory = new Set<string>();
        for (const item of message.modules) {
            if (!Number.isInteger(item.moduleId) || !Number.isInteger(item.moduleVersion) || !Number.isInteger(item.moduleSize) ||
                item.moduleSize < 1 || item.moduleSize > this._maxModuleBytes) {
                this.stats.malformed++;
                return;
            }
            inventory.add(this._moduleKey(pid, message.downloadId, item.moduleId, item.moduleVersion));
        }
        for (const [key, module] of this._modules) {
            if (module.pid === pid && (module.downloadId !== message.downloadId || !inventory.has(key))) {
                this._discardModule(key);
            }
        }
        for (const item of message.modules) {
            const key = this._moduleKey(pid, message.downloadId, item.moduleId, item.moduleVersion);
            const previous = this._modules.get(key);
            if (previous && previous.data.length === item.moduleSize && previous.blockSize === message.blockSize) {
                continue;
            }
            if (previous) {
                this._discardModule(key);
            }
            if (this.stats.bufferedBytes + item.moduleSize > this._maxBufferedBytes) {
                this.stats.malformed++;
                return;
            }
            const data = Buffer.allocUnsafeSlow(item.moduleSize).fill(0);
            this._modules.set(key, { pid, downloadId: message.downloadId, moduleId: item.moduleId,
                moduleVersion: item.moduleVersion, blockSize: message.blockSize, data, blocks: new Set() });
            this.stats.bufferedBytes += data.length;
        }
    }

    private _onDdb(pid: number, message: any): void {
        const key = this._moduleKey(pid, message.downloadId, message.moduleId, message.moduleVersion);
        const module = this._modules.get(key);
        if (!module || module.blocks.has(message.blockNumber) || !Buffer.isBuffer(message.blockDataByte) || !Number.isInteger(message.blockNumber)) {
            return;
        }
        const offset = message.blockNumber * module.blockSize;
        const expected = Math.min(module.blockSize, module.data.length - offset);
        if (expected < 1 || message.blockDataByte.length !== expected) {
            this.stats.malformed++;
            this._discardModule(key);
            return;
        }
        message.blockDataByte.copy(module.data, offset);
        module.blocks.add(message.blockNumber);
        if (module.blocks.size !== Math.ceil(module.data.length / module.blockSize)) {
            return;
        }
        this._modules.delete(key);
        this.stats.bufferedBytes -= module.data.length;
        this.stats.completed++;
        this._options.onModule({ pid: module.pid, downloadId: module.downloadId, moduleId: module.moduleId,
            moduleVersion: module.moduleVersion, data: module.data });
    }

    private _discardAll(): void {
        this.stats.discarded += this._modules.size;
        this._modules.clear();
        this.stats.bufferedBytes = 0;
    }
}
