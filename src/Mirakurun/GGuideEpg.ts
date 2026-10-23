/*
   Copyright 2026 huggy

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0
*/
import * as apid from "../../api";

/** Join schedules, never derive an EIT identity from a private GGID. */
export function enrichGGuideEpg(assets: apid.GGuideAsset[], programs: Iterable<apid.Program>): apid.GGuideAsset[] {
    const key = (value: { networkId: number; serviceId: number; startAt?: number }) =>
        JSON.stringify([value.networkId, value.serviceId, value.startAt]);
    const events = new Map<string, apid.Program[]>();
    for (const asset of assets) {
        for (const association of asset.programs || []) {
            if (association.startAt !== undefined) { events.set(key(association), []); }
        }
    }
    for (const program of programs) {
        events.get(key(program))?.push(program);
    }
    return assets.map(asset => ({ ...asset, programs: (asset.programs || []).map(association => {
        const candidates = (events.get(key(association)) || []).filter(event =>
            association.duration === undefined || event.duration === association.duration);
        if (candidates.length !== 1) { return association; }
        // Match the public Program response; internal EIT flags are not API fields.
        const program = Object.fromEntries(Object.entries(candidates[0]).filter(([name]) => !name.startsWith("_"))) as unknown as apid.Program;
        return { ...association, programId: program.id, eventId: program.eventId,
            description: program.description, extended: program.extended, program };
    }) }));
}
