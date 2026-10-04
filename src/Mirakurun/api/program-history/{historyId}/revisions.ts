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
import * as api from "../../../api";
import _ from "../../../_";
import { isProgramHistoryId, parseProgramHistoryRevisionsQuery, respondHistoryError } from "../../program-history";

export const parameters = [
    { in: "path", name: "historyId", type: "string", format: "uuid", required: true }
];

export const get: Operation = async (req, res, next) => {
    const historyId = req.params.historyId;
    if (isProgramHistoryId(historyId) === false) {
        api.responseError(res, 400);
        return;
    }

    try {
        const page = await _.program.history.response("revisions", { historyId, query: parseProgramHistoryRevisionsQuery(req.query) });
        if (page === null) {
            api.responseError(res, 404);
            return;
        }
        await api.responseJSON(res, page, json => json);
    } catch (err) {
        if (respondHistoryError(res, err)) {
            return;
        }
        next(err);
    }
};

get.apiDoc = {
    tags: ["program-history"],
    operationId: "getProgramHistoryRevisions",
    parameters: [
        { in: "query", name: "limit", type: "integer", minimum: 1, maximum: 500 },
        { in: "query", name: "cursor", type: "string" }
    ],
    responses: {
        200: { description: "OK", schema: { $ref: "#/definitions/ProgramHistoryRevisionPage" } },
        400: { description: "Invalid query", schema: { $ref: "#/definitions/Error" } },
        404: { description: "Not Found", schema: { $ref: "#/definitions/Error" } },
        503: { description: "History store unavailable", schema: { $ref: "#/definitions/Error" } },
        default: { description: "Unexpected Error", schema: { $ref: "#/definitions/Error" } }
    }
};
