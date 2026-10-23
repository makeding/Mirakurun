/*
   Copyright 2018 kanreisa

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
import * as apid from "../api";
import { channelRoutes } from "./Mirakurun/common";
import Client from "./client";
import { IncomingMessage } from "http";
import { REMOTE_EXIT_CHANNEL_UNAVAILABLE, REMOTE_EXIT_SOURCE_UNAVAILABLE } from "./remoteExitCodes";

process.title = "Mirakurun: Remote";

process.stdin.resume();
process.stdin.on("data", () => exit());
process.on("SIGTERM", () => exit());

const opt = {
    host: process.argv[2],
    port: parseInt(process.argv[3], 10),
    type: process.argv[4] as apid.ChannelType,
    channel: process.argv[5],
    decode: process.argv.includes("decode") === true,
    allowNested: process.argv.includes("allow-nested") === true,
    route: channelRoutes.find(route => process.argv.includes(`route=${route}`)),
    format: (process.argv.includes("format=tlv") ? "tlv" : process.argv.includes("format=ts") ? "ts" : undefined) as apid.StreamFormat | undefined
};

console.error("remote:", opt);

let stream: IncomingMessage;

const client = new Client();
client.host = opt.host;
client.port = opt.port;
client.userAgent = "Mirakurun (Remote)";

client.getChannelStream({
    type: opt.type,
    channel: opt.channel,
    route: opt.route,
    decode: opt.decode,
    format: opt.format,
    localTunerOnly: opt.allowNested === false
})
    .then(_stream => {
        stream = _stream;
        stream.pipe(process.stdout);
        stream.once("end", () => exit());
    })
    .catch(err => {
        if (err.req) {
            console.error("remote:", "(error)", err.req.path, err.statusCode, err.statusMessage);
            exit(err.statusCode === 404 ? REMOTE_EXIT_CHANNEL_UNAVAILABLE : REMOTE_EXIT_SOURCE_UNAVAILABLE);
        } else {
            console.error("remote:", "(error)", err.address, err.code);
            exit(REMOTE_EXIT_SOURCE_UNAVAILABLE);
        }
    });

function exit(code = 0) {
    console.error("remote:", "exit.");

    if (stream) {
        stream.unpipe();
    }

    process.exit(code);
}
