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
import type ChannelItem from "./ChannelItem";
import type TunerDevice from "./TunerDevice";
import type { TunerStartupFailureScope } from "./TunerDevice";

export function getSourceKey(device: TunerDevice): string {
    return device.isRemote
        ? `${device.config.remoteMirakurunHost}:${device.config.remoteMirakurunPort || 40772}`
        : `device:${device.index}`;
}

function groupKey(device: TunerDevice, channel: ChannelItem): string {
    return device.config.group !== undefined ? `group:${device.config.group}` :
        `group:${device.isRemote ? getSourceKey(device) : "local"}:${channel.route}`;
}

function attemptKey(device: TunerDevice, channel: ChannelItem): string {
    return `${device.index}:${channel.type}:${channel.route}:${channel.channel}`;
}

/** Failure preferences live only as long as the acquisition that owns them. */
export default class TunerSession {
    private _attempted = new Set<string>();
    private _failedGroups = new Set<string>();
    private _failedSources = new Set<string>();
    private _deviceFailureUntil = new Map<number, number>();
    private _handoffs = new Set<string>();

    hasAttempted(device: TunerDevice, channel: ChannelItem): boolean {
        return this._attempted.has(attemptKey(device, channel));
    }

    fail(device: TunerDevice, channel: ChannelItem, scope: TunerStartupFailureScope): void {
        this._attempted.add(attemptKey(device, channel));
        this._failedGroups.add(groupKey(device, channel));
        if (device.isRemote && scope === "source") {
            this._failedSources.add(getSourceKey(device));
        }
        this._deviceFailureUntil.set(device.index, Date.now() + (device.config.cooldownSeconds ?? 2) * 1000);
    }

    rank(device: TunerDevice, channel: ChannelItem, reusable = false): number {
        if (reusable) { return 0; }
        if (this._failedSources.has(getSourceKey(device)) ||
            (this._deviceFailureUntil.get(device.index) || 0) > Date.now()) { return 2; }
        return this._failedGroups.has(groupKey(device, channel)) ? 1 : 0;
    }

    beginHandoff(source: TunerDevice, target: TunerDevice, channel: ChannelItem): boolean {
        const key = `${source.index}:${attemptKey(target, channel)}`;
        if (this._handoffs.has(key)) { return false; }
        this._handoffs.add(key);
        return true;
    }
}
