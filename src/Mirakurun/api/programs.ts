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
import { Operation } from "express-openapi";
import * as api from "../api";
import _ from "../_";
import { rejectWhere, WhereQueryError } from "../common";

export const get: Operation = async (req, res, next) => {
    try {
        rejectWhere(req.query);
        const json = await _.program.snapshot.getResponse(req.query);
        if (res.destroyed) {
            return;
        }
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Length", json.length);
        res.status(200).end(json);
    } catch (err) {
        if (err instanceof WhereQueryError) {
            api.responseError(res, 400);
            return;
        }
        next(err);
    }
};

get.apiDoc = {
    tags: ["programs"],
    operationId: "getPrograms",
    parameters: [
        {
            in: "query",
            name: "networkId",
            type: "integer",
            required: false
        },
        {
            in: "query",
            name: "serviceId",
            type: "integer",
            required: false
        },
        {
            in: "query",
            name: "eventId",
            type: "integer",
            required: false
        }
    ],
    responses: {
        200: {
            description: "OK",
            schema: {
                type: "array",
                items: {
                    $ref: "#/definitions/Program"
                }
            }
        },
        default: {
            description: "Unexpected Error",
            schema: {
                $ref: "#/definitions/Error"
            }
        }
    }
};
