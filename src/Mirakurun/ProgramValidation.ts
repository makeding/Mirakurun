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
import { Program } from "./db";
import * as log from "./log";

export function programValidationError(program: Program): string | undefined {
    const fields = ["id", "networkId", "serviceId", "eventId", "startAt", "duration"];
    const invalid = fields.filter(field => !Number.isSafeInteger(program?.[field]) || program[field] < 0);
    if (typeof program?.isFree !== "boolean") { invalid.push("isFree"); }
    if (invalid.length === 0) { return; }
    const describe = (field: string) => `${field}=${String(program?.[field]).slice(0, 80)}`;
    return `Invalid program (${fields.slice(0, 4).map(describe).join(", ")}): ${invalid.map(describe).join(", ")}`;
}

export function acceptProgram(program: Program): boolean {
    const error = programValidationError(program);
    if (!error) { return true; }
    log.warn("Rejected program update: %s", error);
    return false;
}
