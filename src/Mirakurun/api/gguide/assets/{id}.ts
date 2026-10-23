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
import { getGGuide } from "../../gguide";

export const parameters = [{ in: "path", name: "id", type: "string", pattern: "^[a-f0-9]{64}$", required: true }];
export const get: Operation = async (req, res, next) => {
    try {
        const material = await getGGuide().read(req.params.id);
        if (!material) { api.responseError(res, 404); return; }
        if (!material.asset.displayable) {
            api.responseError(res, 422, material.asset.unsupportedReason || "Image requires unsupported external data");
            return;
        }
        res.setHeader("Content-Type", material.asset.mimeType);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Length", material.data.length);
        res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
        res.setHeader("ETag", `"${material.asset.id}"`);
        res.status(200).end(material.data);
    } catch (err) { next(err); }
};
get.apiDoc = {
    tags: ["gguide"], operationId: "getGGuideAsset", produces: ["image/png", "image/jpeg", "application/json"],
    responses: {
        200: { description: "Independently displayable image bytes" },
        404: { description: "Unknown material" },
        422: { description: "External palette or other decoding dependency is unresolved" },
        default: { description: "Error", schema: { $ref: "#/definitions/Error" } }
    }
};
