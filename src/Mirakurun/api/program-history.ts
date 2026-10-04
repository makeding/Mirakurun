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
import { Operation } from "express-openapi";
import * as api from "../api";
import _ from "../_";

export interface ProgramHistoryQuery {
    from: number;
    to: number;
    networkId?: number;
    serviceId?: number;
    eventId?: number;
    limit: number;
    cursor?: string;
}

export interface ProgramHistoryRevisionsQuery {
    limit: number;
    cursor?: string;
}

const listKeys = new Set(["from", "to", "networkId", "serviceId", "eventId", "limit", "cursor"]);
const revisionsKeys = new Set(["limit", "cursor"]);

export function parseProgramHistoryQuery(query: unknown): ProgramHistoryQuery {
    rejectUnknownQueryKeys(query, listKeys);
    const source = query as Record<string, unknown>;
    const from = parseNonNegativeInteger(source.from);
    const to = parseNonNegativeInteger(source.to);

    if (from === undefined || to === undefined || from >= to) {
        throw new HistoryApiQueryError();
    }

    return {
        from,
        to,
        networkId: parseOptionalIdentifier(source.networkId),
        serviceId: parseOptionalIdentifier(source.serviceId),
        eventId: parseOptionalIdentifier(source.eventId),
        limit: parseLimit(source.limit),
        cursor: parseCursor(source.cursor)
    };
}

export function parseProgramHistoryRevisionsQuery(query: unknown): ProgramHistoryRevisionsQuery {
    rejectUnknownQueryKeys(query, revisionsKeys);
    const source = query as Record<string, unknown>;

    return {
        limit: parseLimit(source.limit),
        cursor: parseCursor(source.cursor)
    };
}

export function isProgramHistoryId(value: unknown): value is string {
    return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export class HistoryApiQueryError extends Error {
    readonly status = 400;

    constructor() {
        super("invalid program history query");
        this.name = "HistoryApiQueryError";
    }
}

export function respondHistoryError(res: any, err: unknown): boolean {
    const status = err && typeof err === "object" ? (err as { status?: unknown }).status : undefined;
    if (status === 400 || status === 503) {
        api.responseError(res, status);
        return true;
    }
    return false;
}

export const get: Operation = async (req, res, next) => {
    try {
        const page = await _.program.history.response("list", parseProgramHistoryQuery(req.query));
        await api.responseJSON(res, page, json => json);
    } catch (err) {
        if (respondHistoryError(res, err)) {
            return;
        }
        next(err);
    }
};

function rejectUnknownQueryKeys(query: unknown, allowed: Set<string>): void {
    if (query === null || typeof query !== "object" || Array.isArray(query)) {
        throw new HistoryApiQueryError();
    }
    for (const key of Object.keys(query)) {
        if (allowed.has(key) === false) {
            throw new HistoryApiQueryError();
        }
    }
}

function parseNonNegativeInteger(value: unknown): number | undefined {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    }
    if (typeof value !== "string" || /^(0|[1-9][0-9]*)$/.test(value) === false) {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseOptionalIdentifier(value: unknown): number | undefined {
    if (typeof value === "undefined") {
        return undefined;
    }
    const parsed = parseNonNegativeInteger(value);
    if (typeof parsed === "undefined" || parsed > 65535) {
        throw new HistoryApiQueryError();
    }
    return parsed;
}

function parseLimit(value: unknown): number {
    if (typeof value === "undefined") {
        return 100;
    }
    const parsed = parseNonNegativeInteger(value);
    if (typeof parsed === "undefined" || parsed < 1 || parsed > 500) {
        throw new HistoryApiQueryError();
    }
    return parsed;
}

function parseCursor(value: unknown): string | undefined {
    if (typeof value === "undefined") {
        return undefined;
    }
    if (typeof value !== "string" || value.length === 0) {
        throw new HistoryApiQueryError();
    }
    return value;
}

get.apiDoc = {
    tags: ["program-history"],
    operationId: "getProgramHistory",
    parameters: [
        { in: "query", name: "from", type: "integer", minimum: 0, required: true },
        { in: "query", name: "to", type: "integer", minimum: 1, required: true },
        { in: "query", name: "networkId", type: "integer", minimum: 0, maximum: 65535 },
        { in: "query", name: "serviceId", type: "integer", minimum: 0, maximum: 65535 },
        { in: "query", name: "eventId", type: "integer", minimum: 0, maximum: 65535 },
        { in: "query", name: "limit", type: "integer", minimum: 1, maximum: 500 },
        { in: "query", name: "cursor", type: "string" }
    ],
    responses: {
        200: { description: "OK", schema: { $ref: "#/definitions/ProgramHistoryPage" } },
        400: { description: "Invalid query", schema: { $ref: "#/definitions/Error" } },
        503: { description: "History store unavailable", schema: { $ref: "#/definitions/Error" } },
        default: { description: "Unexpected Error", schema: { $ref: "#/definitions/Error" } }
    }
};
