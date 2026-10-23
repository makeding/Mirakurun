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
import { GGuideError } from "../GGuide";

export function getGGuide() {
    if (!_.gguide) { throw new GGuideError(503, "GGuide is not initialized"); }
    return _.gguide;
}

export const get: Operation = async (req, res, next) => {
    try { await api.responseJSON(res, getGGuide().status); } catch (err) { next(err); }
};

get.apiDoc = {
    tags: ["gguide"], operationId: "getGGuideStatus",
    responses: {
        200: { description: "Material collection status", schema: { $ref: "#/definitions/GGuideStatus" } },
        default: { description: "Error", schema: { $ref: "#/definitions/Error" } }
    }
};

export const put: Operation = async (req, res, next) => {
    try {
        if (typeof req.body?.enabled !== "boolean") { throw new GGuideError(400, "Expected enabled boolean"); }
        await getGGuide().setEnabled(req.body.enabled);
        await api.responseJSON(res, getGGuide().status);
    } catch (err) { next(err); }
};

put.apiDoc = {
    tags: ["gguide"], operationId: "setGGuideEnabled",
    parameters: [{ in: "body", name: "body", required: true, schema: {
        type: "object", required: ["enabled"], additionalProperties: false,
        properties: { enabled: { type: "boolean" } }
    } }],
    responses: get.apiDoc.responses
};
