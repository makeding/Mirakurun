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
import { spawnSync } from "child_process";
import { existsSync, readdirSync } from "fs";
import * as apid from "../../api";
import * as log from "./log";
import * as common from "./common";
export { validateDvbConfig } from "../DvbConfig";

export interface DvbFrontend {
    path: string;
    adapter: number;
    frontend: number;
    systems: string[];
}

interface DvbChannel {
    type: apid.ChannelType;
    route: apid.ChannelRoute;
}

const FRONTEND_PATH = /^\/dev\/dvb\/adapter(\d+)\/frontend(\d+)$/;
const DVB_PATH = /\/dev\/dvb\/adapter(\d+)\/(?:frontend|demux|dvr)\d+/g;

export function parseDvbDeliverySystems(output: string): string[] {
    // Only consume the advertised list, never a device name or the current system.
    const list = output.replace(/\x1b\[[0-9;]*m/g, "").split(/Supported delivery systems?:\s*\n/)[1];
    if (!list) { return []; }
    const systems: string[] = [];
    for (const line of list.split(/\r?\n/)) {
        const match = /^\s*\[?([A-Z][A-Z0-9_/-]*)\]?\s*$/.exec(line);
        if (!match) { break; }
        systems.push(match[1]);
    }
    return [...new Set(systems)];
}

export function discoverDvbFrontends(
    readDirectory: (path: string) => string[] = readdirSync,
    probe: (adapter: number, frontend: number) => string = probeDvbFrontend
): DvbFrontend[] {
    const frontends: DvbFrontend[] = [];
    let adapters: string[];
    try {
        adapters = readDirectory("/dev/dvb");
    } catch (err) {
        log.warn("DVB discovery cannot enumerate /dev/dvb: %s", err.message);
        return frontends;
    }
    for (const adapterName of adapters.filter(name => /^adapter\d+$/.test(name)).sort(numericSort)) {
        let nodes: string[];
        try {
            nodes = readDirectory(`/dev/dvb/${adapterName}`);
        } catch (err) {
            log.warn("DVB discovery cannot enumerate %s: %s", adapterName, err.message);
            continue;
        }
        for (const node of nodes.filter(name => /^frontend\d+$/.test(name)).sort(numericSort)) {
            const path = `/dev/dvb/${adapterName}/${node}`;
            const adapter = Number(adapterName.slice(7));
            const frontend = Number(node.slice(8));
            try {
                const systems = parseDvbDeliverySystems(probe(adapter, frontend));
                if (systems.length === 0) { throw new Error("driver returned no supported delivery systems"); }
                frontends.push({ path, adapter, frontend, systems });
                log.info("DVB discovered %s: %s", path, systems.join(", "));
            } catch (err) {
                log.warn("DVB discovery failed for %s: %s", path, err.message);
            }
        }
    }
    return frontends;
}

export function generateDvbTunerConfigs(frontends: DvbFrontend[]): apid.ConfigTunersItem[] {
    const configs: apid.ConfigTunersItem[] = [];
    for (const adapter of [...new Set(frontends.map(frontend => frontend.adapter))]) {
        const systems = frontends.filter(frontend => frontend.adapter === adapter).flatMap(frontend => frontend.systems);
        const terrestrial = systems.includes("ISDBT");
        if (!terrestrial && !systems.includes("ISDBS")) { continue; }
        configs.push({
            name: `adapter${adapter}`,
            types: terrestrial ? ["GR"] : ["BS", "CS"],
            dvbAutoDiscovery: true,
            command: `dvbv5-zap -a <dvbAdapter> -f <dvbFrontend> -c ./config/dvbconf-for-isdb/conf/dvbv5_channels_isdb${terrestrial ? "t" : "s"}.conf -r -P -o - <channel>`,
            decoder: "arib-b25-stream-test"
        });
    }
    return configs;
}

function numericSort(a: string, b: string): number {
    return a.localeCompare(b, "en", { numeric: true });
}

function probeDvbFrontend(adapter: number, frontend: number): string {
    const result = spawnSync("dvb-fe-tool", ["-a", String(adapter), "-f", String(frontend)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
        timeout: 2000,
        maxBuffer: 64 * 1024
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.error || result.status !== 0) {
        throw new Error(`dvb-fe-tool failed (${result.error?.message || result.signal || result.status}): ${output.trim()}`);
    }
    return output;
}

export function supportsDvbChannel(frontend: DvbFrontend, channel: DvbChannel): boolean {
    let systems: string[];
    if (channel.route === "TER") {
        systems = channel.type === "GR" || channel.type === "GR-ALT" ? ["ISDBT"] : [];
    } else if (channel.route === "CATV" || channel.route === "HIKARI") {
        systems = channel.type === "GR" || channel.type === "GR-ALT" ? ["ISDBT"] : ["ISDBC"];
    } else {
        systems = channel.type === "BS4K" ? ["ISDBS3"] : channel.type === "SKY" ? ["DVBS", "DVBS2"] :
            channel.type === "BS" || channel.type === "CS" ? ["ISDBS"] : [];
    }
    return systems.some(system => frontend.systems.includes(system));
}

/** One lease per adapter: frontend modes may share a single demux/DVR pipeline. */
export class DvbFrontendPool {
    private _leases = new Map<number, { owner: number; frontend: DvbFrontend }>();
    private _reservations = new Map<number, Set<number>>();
    private _legacyAdapters = new Set<number>();

    constructor(
        private _frontends: DvbFrontend[],
        private _configs: readonly apid.ConfigTunersItem[],
        private _exists: (path: string) => boolean = existsSync
    ) {
        _configs.forEach((config, owner) => {
            if (config.isDisabled || config.remoteMirakurunHost) { return; }
            if (config.dvbAutoDiscovery === true) {
                const pin = FRONTEND_PATH.exec(config.dvbFrontendPath || "");
                if (pin) {
                    const adapter = Number(pin[1]);
                    const owners = this._reservations.get(adapter) || new Set<number>();
                    owners.add(owner);
                    this._reservations.set(adapter, owners);
                }
                return;
            }
            for (const value of [config.dvbDevicePath, config.checkDevicePath, config.command, config.commandBS4K]) {
                for (const match of (value || "").matchAll(DVB_PATH)) {
                    this._legacyAdapters.add(Number(match[1]));
                }
            }
            for (const command of [config.command, config.commandBS4K]) {
                if (!/^\s*(?:\S*\/)?dvbv5-zap(?:\s|$)/.test(command || "")) { continue; }
                const adapter = /(?:^|\s)(?:-a\s*|--adapter[=\s]+)(\d+)(?=\s|$)/.exec(command);
                this._legacyAdapters.add(adapter ? Number(adapter[1]) : 0);
            }
        });
    }

    canAcquire(owner: number, channel?: DvbChannel): boolean {
        return !!this._find(owner, channel);
    }

    acquire(owner: number, channel: DvbChannel): DvbFrontend {
        const existing = [...this._leases.values()].find(lease => lease.owner === owner);
        if (existing) {
            if (supportsDvbChannel(existing.frontend, channel)) { return existing.frontend; }
            throw new Error(`DVB tuner #${owner} must release its current frontend before retuning`);
        }
        const frontend = this._find(owner, channel);
        if (!frontend) { throw new Error(`No free compatible DVB frontend for tuner #${owner}`); }
        this._leases.set(frontend.adapter, { owner, frontend });
        return frontend;
    }

    release(owner: number): void {
        for (const [adapter, lease] of this._leases) {
            if (lease.owner === owner) { this._leases.delete(adapter); }
        }
    }

    private _find(owner: number, channel?: DvbChannel): DvbFrontend | undefined {
        const config = this._configs[owner];
        if (!config || config.dvbAutoDiscovery !== true || config.isDisabled) { return undefined; }
        const channels: DvbChannel[] = channel ? [channel] : config.types.flatMap(type =>
            (config.routes?.length ? config.routes : [common.defaultRouteForType(type)]).map(route => ({ type, route })));
        return [...this._frontends].sort((a, b) => a.systems.length - b.systems.length).find(frontend => {
            const reservations = this._reservations.get(frontend.adapter);
            const lease = this._leases.get(frontend.adapter);
            return (!config.dvbFrontendPath || frontend.path === config.dvbFrontendPath) &&
                !this._legacyAdapters.has(frontend.adapter) &&
                (!reservations || (reservations.size === 1 && reservations.has(owner))) &&
                (!lease || lease.owner === owner) &&
                channels.some(candidate => supportsDvbChannel(frontend, candidate)) && this._exists(frontend.path);
        });
    }
}
