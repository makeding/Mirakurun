/*
   Copyright 2016 kanreisa

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
Buffer.poolSize = 0; // disable memory pool

require("dotenv").config();
import { execSync } from "child_process";
import { createHash } from "crypto";
import { dirname, join } from "path";

if (process.platform !== "linux") {
    console.warn("running in not linux!");
}

if (process.getuid() === 0) {
    try {
        execSync(`renice -n -10 -p ${ process.pid }`);
        execSync(`ionice -c 1 -n 7 -p ${ process.pid }`);
    } catch (e) {
        console.warn("error on modify nice: " + (e as Error).message);
    }
} else {
    console.warn("running in not root!");
}

process.title = "Mirakurun: Server";

process.on("uncaughtException", err => {
    ++status.errorCount.uncaughtException;
    console.error(err.stack);
});
process.on("unhandledRejection", err => {
    ++status.errorCount.unhandledRejection;
    console.error(err);
});

function setEnv(name: string, value: string) {
    process.env[name] = process.env[name] || value;
}
setEnv("SERVER_CONFIG_PATH", "/usr/local/etc/mirakurun/server.yml");
setEnv("TUNERS_CONFIG_PATH", "/usr/local/etc/mirakurun/tuners.yml");
setEnv("CHANNELS_CONFIG_PATH", "/usr/local/etc/mirakurun/channels.yml");
setEnv("SERVICES_DB_PATH", "/usr/local/var/db/mirakurun/services.json");
setEnv("PROGRAMS_DB_PATH", "/usr/local/var/db/mirakurun/programs.json");
setEnv("PROGRAM_HISTORY_DB_PATH", join(dirname(process.env.PROGRAMS_DB_PATH), "programs.sqlite"));
setEnv("LOGO_DATA_DIR_PATH", "/usr/local/var/db/mirakurun/logo-data");

import _ from "./Mirakurun/_";
import status from "./Mirakurun/status";
import Event from "./Mirakurun/Event";
import Job from "./Mirakurun/Job";
import Tuner from "./Mirakurun/Tuner";
import Channel from "./Mirakurun/Channel";
import Service from "./Mirakurun/Service";
import Program from "./Mirakurun/Program";
import Server from "./Mirakurun/Server";
import * as config from "./Mirakurun/config";
import * as log from "./Mirakurun/log";

function sortForIntegrity(value: any): any {
    if (Array.isArray(value)) {
        return value.map(item => sortForIntegrity(item));
    }
    if (value !== null && typeof value === "object") {
        return Object.keys(value).sort().reduce((result, key) => {
            if (key !== "allowedTuners") {
                result[key] = sortForIntegrity(value[key]);
            }
            return result;
        }, {});
    }

    return value;
}

(async function top() {
    _.config.server = await config.loadServer();
    _.config.channels = await config.loadChannels();
    // Invalidate services/programs cache when channel config changes. allowedTuners only limits device selection,
    // so keep it out of the integrity hash to avoid unnecessary channel rescans.
    _.configIntegrity.channels = createHash("sha256").update(JSON.stringify(sortForIntegrity(_.config.channels))).digest("base64");
    _.config.tuners = await config.loadTuners();

    if (typeof _.config.server.logLevel === "number") {
        (<any> log).logLevel = _.config.server.logLevel;
    }
    if (typeof _.config.server.maxLogHistory === "number") {
        (<any> log).maxLogHistory = _.config.server.maxLogHistory;
    }

    _.event = new Event();
    _.job = new Job();
    _.tuner = new Tuner();
    _.channel = new Channel();
    _.service = new Service();
    _.program = new Program({ onStorageFailure: () => { shutdown(1).catch(console.error); } });
    _.server = new Server();

    await _.service.load();
    await _.program.load();

    if (process.env.SETUP === "true") {
        log.info("setup is done.");
        await _.program.close();
        _.job.close();
        process.exit(0);
    }

    await _.server.init();
})().catch(err => {
    console.error(err.stack || err);
    shutdown(1).catch(() => process.exit(1));
});

let shuttingDown: Promise<void>;
function shutdown(code: number): Promise<void> {
    if (!shuttingDown) {
        shuttingDown = (async () => {
            _.job?.close();
            await Promise.allSettled((_.tuner?.devices || []).map(device => _.tuner.get(device.index).kill()));
            try {
                await _.server?.deinit();
                await _.program?.close();
            } finally {
                process.exit(code);
            }
        })();
    }
    return shuttingDown;
}
process.on("SIGTERM", () => { shutdown(0).catch(console.error); });
process.on("SIGINT", () => { shutdown(0).catch(console.error); });
