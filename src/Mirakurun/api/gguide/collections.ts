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
import * as api from "../../api";
import { getGGuide } from "../gguide";

export const post: Operation = async (req, res, next) => {
    try { await api.responseJSON(res, getGGuide().enqueue(req.body)); } catch (err) { next(err); }
};
post.apiDoc = {
    tags: ["gguide"], operationId: "collectGGuide",
    parameters: [{ in: "body", name: "collection", required: true, schema: { $ref: "#/definitions/GGuideCollectionRequest" } }],
    responses: {
        200: { description: "Queued job; poll and cancel using the Job API", schema: { $ref: "#/definitions/JobItem" } },
        400: { description: "Invalid collection request" },
        404: { description: "Configured channel not found" },
        409: { description: "A collection is already queued or running" },
        503: { description: "Key or storage unavailable" },
        default: { description: "Error", schema: { $ref: "#/definitions/Error" } }
    }
};
