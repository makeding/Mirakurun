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
import type { ConfigTunersItem } from "../api";

const FRONTEND_PATH = /^\/dev\/dvb\/adapter(\d+)\/frontend(\d+)$/;

export function validateDvbConfig(config: ConfigTunersItem): string | null {
    if (config.dvbAutoDiscovery !== undefined && typeof config.dvbAutoDiscovery !== "boolean") {
        return "dvbAutoDiscovery must be boolean";
    }
    if (config.dvbFrontendPath !== undefined && typeof config.dvbFrontendPath !== "string") {
        return "dvbFrontendPath must be a string";
    }
    if (config.dvbAutoDiscovery !== true) {
        return config.dvbFrontendPath ? "dvbFrontendPath requires dvbAutoDiscovery" : null;
    }
    if (config.remoteMirakurunHost) { return "DVB frontend selection requires a local tuner"; }
    if (!config.command && (!config.commandBS4K || config.types?.some(type => type !== "BS4K"))) {
        return "DVB frontend selection requires a tuning command";
    }
    const pin = config.dvbFrontendPath && FRONTEND_PATH.exec(config.dvbFrontendPath);
    if (config.dvbFrontendPath && !pin) { return "dvbFrontendPath must be /dev/dvb/adapterN/frontendM"; }
    if (config.dvbDevicePath && (!pin || config.dvbDevicePath !== `/dev/dvb/adapter${Number(pin[1])}/dvr0`)) {
        return "dvbDevicePath requires a pinned frontend in the same adapter (dvr0)";
    }
    for (const command of [config.command, config.commandBS4K].filter(value => value !== undefined)) {
        if (typeof command !== "string" || (!command.includes("<dvbFrontendPath>") &&
            !(command.includes("<dvbAdapter>") && command.includes("<dvbFrontend>")))) {
            return "DVB commands require <dvbFrontendPath> or both <dvbAdapter> and <dvbFrontend>";
        }
    }
    return null;
}
