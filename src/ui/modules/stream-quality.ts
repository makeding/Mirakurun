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
import { StreamInfo, StreamMeasurement } from "../../../api.d";

export interface StreamQualitySummary {
    packets: number;
    drops: number;
    measuredPackets: number;
    comparedPackets: number;
    unavailablePackets: number;
    duplicatePackets: number;
    reorderedPackets: number;
    resyncPackets: number;
    hasMeasurement: boolean;
}

export function summarizeStreamQuality(streamInfo: StreamInfo): StreamQualitySummary {
    const summary: StreamQualitySummary = {
        packets: 0,
        drops: 0,
        measuredPackets: 0,
        comparedPackets: 0,
        unavailablePackets: 0,
        duplicatePackets: 0,
        reorderedPackets: 0,
        resyncPackets: 0,
        hasMeasurement: false
    };

    for (const key in streamInfo || {}) {
        const entry = streamInfo[key];
        summary.packets += entry.packet;
        summary.drops += entry.drop;
        const measurement: StreamMeasurement | undefined = entry.measurement;
        if (!measurement) {
            continue;
        }
        summary.hasMeasurement = true;
        summary.measuredPackets += measurement.measuredPackets;
        summary.comparedPackets += measurement.comparedPackets;
        summary.unavailablePackets += measurement.unavailablePackets;
        summary.duplicatePackets += measurement.duplicatePackets;
        summary.reorderedPackets += measurement.reorderedPackets;
        summary.resyncPackets += measurement.resyncPackets;
    }

    return summary;
}

export function formatStreamQuality(streamInfo: StreamInfo): string {
    const summary = summarizeStreamQuality(streamInfo);
    if (!summary.hasMeasurement) {
        return `Dropped Pkts: ${summary.drops} / ${summary.packets}`;
    }
    if (summary.comparedPackets === 0) {
        return `MMTP loss: unknown (${summary.unavailablePackets} unmeasured)`;
    }
    return `MMTP sequence gaps: ${summary.drops} / ${summary.comparedPackets} (${summary.unavailablePackets} unmeasured)`;
}
