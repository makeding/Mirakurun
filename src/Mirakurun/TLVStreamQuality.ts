/*
   Copyright 2026 kanreisa

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
import { StreamInfoEntry } from "./common";

const TLV_PACKET_TYPE_COMPRESSED = 0x03;
const CID_HEADER_TYPE_IPV6_UDP_FULL = 0x60;
const CID_HEADER_TYPE_COMPRESSED = 0x61;
const MMTP_HEADER_SIZE = 12;
const HC_IPV6_UDP_FULL_HEADER_SIZE = 38 + 4;
const MAX_ESTIMATED_GAP = 4096;
const MAX_REMEMBERED_RANGES = 128;
const MAX_REMEMBERED_SEQUENCES = 4096;
const MAX_TRACKED_FLOWS = 4096;

/**
 * Estimates sequence gaps from consecutive MMTP headers.
 * The first packet of each CID/packet-id sequence and undecodable TLV packets
 * are deliberately reported as unmeasured instead of as zero loss.
 */
export default class TLVStreamQuality {

    private _sequences = new Map<string, {
        highest: number;
        missing: Array<{ start: number; end: number }>;
        seen: Set<number>;
    }>();
    private _contexts = new Map<number, string>();

    observe(packet: Buffer, entry: StreamInfoEntry): void {
        const measurement = entry.measurement;
        if (packet[1] !== TLV_PACKET_TYPE_COMPRESSED) {
            ++measurement.unavailablePackets;
            return;
        }

        const cid = ((packet[4] << 8) | packet[5]) >> 4;
        const headerType = packet[6];
        const mmtpOffset = headerType === CID_HEADER_TYPE_COMPRESSED ? 7 :
            headerType === CID_HEADER_TYPE_IPV6_UDP_FULL ? 7 + HC_IPV6_UDP_FULL_HEADER_SIZE : -1;
        if (mmtpOffset < 0 || packet.length < mmtpOffset + MMTP_HEADER_SIZE) {
            ++measurement.unavailablePackets;
            return;
        }
        if (headerType === CID_HEADER_TYPE_COMPRESSED && !this._contexts.has(cid)) {
            ++measurement.unavailablePackets;
            return;
        }

        // MMTP v0 reserves the upper two bits of the first byte as zero.
        if ((packet[mmtpOffset] & 0xc0) !== 0) {
            ++measurement.unavailablePackets;
            return;
        }

        if (headerType === CID_HEADER_TYPE_IPV6_UDP_FULL) {
            const endpoint = this._endpointKey(packet);
            if (this._contexts.get(cid) !== endpoint) {
                this._clearCID(cid);
                this._contexts.set(cid, endpoint);
            }
        }
        const packetId = packet.readUInt16BE(mmtpOffset + 2);
        const sequenceNumber = packet.readUInt32BE(mmtpOffset + 8);
        const key = `${cid}:${packetId}`;
        ++measurement.measuredPackets;
        let state = this._sequences.get(key);
        if (state === undefined) {
            if (this._sequences.size >= MAX_TRACKED_FLOWS) {
                --measurement.measuredPackets;
                ++measurement.unavailablePackets;
                return;
            }
            ++measurement.baselinePackets;
            this._sequences.set(key, state = {
                highest: sequenceNumber,
                missing: [],
                seen: new Set([sequenceNumber])
            });
            return;
        }

        ++measurement.comparedPackets;
        if (state.seen.has(sequenceNumber)) {
            ++measurement.duplicatePackets;
            return;
        }
        const distance = (sequenceNumber - state.highest) >>> 0;
        if (distance >= 0x80000000) {
            ++measurement.reorderedPackets;
            if (this._fillMissing(state.missing, sequenceNumber)) {
                --entry.drop;
            }
            state.seen.add(sequenceNumber);
            this._trimSeen(state.seen);
            return;
        }

        if (distance > MAX_ESTIMATED_GAP) {
            ++measurement.resyncPackets;
            state.highest = sequenceNumber;
            state.missing = [];
            state.seen.clear();
            state.seen.add(sequenceNumber);
            return;
        }
        if (distance > 1) {
            this._addMissing(state.missing, (state.highest + 1) >>> 0, (sequenceNumber - 1) >>> 0);
            entry.drop += distance - 1;
        }
        state.highest = sequenceNumber;
        state.seen.add(sequenceNumber);
        this._trimSeen(state.seen);
    }

    private _addMissing(missing: Array<{ start: number; end: number }>, start: number, end: number): void {
        if (start <= end) {
            missing.push({ start, end });
        } else {
            missing.push({ start, end: 0xffffffff }, { start: 0, end });
        }
        while (missing.length > MAX_REMEMBERED_RANGES) {
            missing.shift();
        }
    }

    private _fillMissing(missing: Array<{ start: number; end: number }>, sequenceNumber: number): boolean {
        for (let index = 0; index < missing.length; ++index) {
            const range = missing[index];
            if (sequenceNumber < range.start || sequenceNumber > range.end) {
                continue;
            }
            if (range.start === range.end) {
                missing.splice(index, 1);
            } else if (sequenceNumber === range.start) {
                ++range.start;
            } else if (sequenceNumber === range.end) {
                --range.end;
            } else {
                missing.splice(index, 1,
                    { start: range.start, end: sequenceNumber - 1 },
                    { start: sequenceNumber + 1, end: range.end });
                while (missing.length > MAX_REMEMBERED_RANGES) {
                    missing.shift();
                }
            }
            return true;
        }
        return false;
    }

    private _clearCID(cid: number): void {
        const prefix = `${cid}:`;
        for (const key of this._sequences.keys()) {
            if (key.startsWith(prefix)) {
                this._sequences.delete(key);
            }
        }
    }

    private _endpointKey(packet: Buffer): string {
        // HCIP full header: next-header, source/destination IPv6 addresses,
        // then the source/destination UDP ports.  Traffic class, flow label,
        // and hop limit are deliberately outside the IP-dataflow identity.
        return Buffer.concat([
            packet.subarray(11, 12),
            packet.subarray(13, 45),
            packet.subarray(45, 49)
        ]).toString("hex");
    }

    private _trimSeen(seen: Set<number>): void {
        while (seen.size > MAX_REMEMBERED_SEQUENCES) {
            seen.delete(seen.values().next().value);
        }
    }
}
