import { validate } from "@purduehackers/sign-script-validator";
import { Result } from "better-result";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { z } from "zod";

import { env } from "../env";
import {
  ErrorResponseSchema,
  jsonResponse,
  OkResponseSchema,
  rejectInvalidBody,
  WEBSOCKET_RESPONSES,
} from "../lib/openapi";
import type { RedisCommandFailed } from "../lib/redis";
import { decodeJson, socketRoute } from "../lib/ws";
import {
  SignScriptPushResponseSchema,
  SignScriptRejectedSchema,
  SignScriptResponseSchema,
  SignSetScriptRequestSchema,
  SignSetWifiRequestSchema,
  SignStatusResponseSchema,
  SignWifiResponseSchema,
} from "../protocol/sign";
import * as signService from "../services/sign";

const sign = new Hono();

/**
 * The sign's HTTP routes carry WiFi credentials and control the lights,
 * so unlike api-v3 they require the API key.
 */
const requireBearer: MiddlewareHandler = async (c, next) => {
  if (c.req.header("authorization") !== `Bearer ${env.PHACK_API_KEY}`) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  await next();
};

const bearerSecurity = [{ bearerAuth: [] }];

/** What the WASM validator's JSON string parses into. */
const ValidationResultSchema = z.object({
  ok: z.boolean(),
  artifact: z.string().optional(),
  error: z.string().optional(),
  line: z.number().optional(),
  col: z.number().optional(),
});

const errorResponses = {
  401: jsonResponse("Missing or invalid API key.", ErrorResponseSchema),
  404: jsonResponse("No sign connected.", ErrorResponseSchema),
  504: jsonResponse("No sign responded in time.", ErrorResponseSchema),
  500: jsonResponse("Internal server error.", ErrorResponseSchema),
};

/** Maps every sign service error to its HTTP response. */
function errorResponse(
  error:
    | signService.SignNotConnected
    | signService.SignTimedOut
    | signService.SignQueryFailed
    | RedisCommandFailed,
): Response {
  switch (error._tag) {
    case "SignNotConnected":
      return Response.json({ error: error.message }, { status: 404 });
    case "SignTimedOut":
      return Response.json({ error: error.message }, { status: 504 });
    case "SignQueryFailed":
    case "RedisCommandFailed":
      return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

sign.get(
  "/ws",
  describeRoute({
    tags: ["Sign"],
    summary: "Sign WebSocket",
    description:
      "WebSocket endpoint for the physical signs. A sign authenticates with an `auth` frame, then answers server-pushed `get_wifi`/`set_wifi`/`set_script`/`clear_script` requests and may send `ping`, `status`, and script lifecycle frames. Every connected sign mirrors the same content.",
    responses: WEBSOCKET_RESPONSES,
  }),
  async (c, next) => {
    // Firmware 0.3.1+ reports its version here (PHSign/x.y.z), which
    // tells connecting firmwares apart in the logs.
    console.log(`Sign WS upgrade from: ${c.req.header("user-agent") ?? "unknown"}`);
    await next();
  },
  ...socketRoute({
    connect: (ws) => signService.connect(ws),
    message: (connection, data) => signService.handleMessage(connection, data),
    close: (connection) => signService.disconnect(connection),
  }),
);

sign.get(
  "/status",
  describeRoute({
    tags: ["Sign"],
    summary: "Count connected signs",
    security: bearerSecurity,
    responses: {
      200: jsonResponse("How many signs are connected.", SignStatusResponseSchema),
      401: errorResponses[401],
      500: errorResponses[500],
    },
  }),
  requireBearer,
  () =>
    signService.countConnected().then(
      Result.match({
        ok: (connected): Response => Response.json({ connected }),
        err: errorResponse,
      }),
    ),
);

sign.get(
  "/wifi",
  describeRoute({
    tags: ["Sign"],
    summary: "Read the WiFi networks stored on the signs",
    description: "Broadcasts the read to every connected sign. The first reply wins.",
    security: bearerSecurity,
    responses: {
      200: jsonResponse("The networks stored on the signs.", SignWifiResponseSchema),
      401: errorResponses[401],
      404: errorResponses[404],
      504: errorResponses[504],
      500: errorResponses[500],
    },
  }),
  requireBearer,
  () =>
    signService.getWifi().then(
      Result.match({
        ok: (networks): Response => Response.json({ networks }),
        err: errorResponse,
      }),
    ),
);

sign.put(
  "/wifi",
  describeRoute({
    tags: ["Sign"],
    summary: "Replace the WiFi networks on every connected sign",
    security: bearerSecurity,
    responses: {
      200: jsonResponse("At least one sign stored the networks.", OkResponseSchema),
      400: jsonResponse("Invalid request body.", ErrorResponseSchema),
      401: errorResponses[401],
      404: errorResponses[404],
      504: errorResponses[504],
      500: errorResponses[500],
    },
  }),
  requireBearer,
  validator("json", SignSetWifiRequestSchema, rejectInvalidBody),
  (c) =>
    signService.setWifi(c.req.valid("json").networks).then(
      Result.match({
        ok: (): Response => Response.json({ ok: true }),
        err: errorResponse,
      }),
    ),
);

sign.get(
  "/script",
  describeRoute({
    tags: ["Sign"],
    summary: "Read the stored script",
    security: bearerSecurity,
    responses: {
      200: jsonResponse("The stored script.", SignScriptResponseSchema),
      401: errorResponses[401],
      404: jsonResponse("No script set.", ErrorResponseSchema),
      500: errorResponses[500],
    },
  }),
  requireBearer,
  () =>
    signService.getScript().then(
      Result.match({
        ok: (script): Response => Response.json(script),
        err: (error): Response =>
          error._tag === "SignScriptNotFound"
            ? Response.json({ error: error.message }, { status: 404 })
            : errorResponse(error),
      }),
    ),
);

sign.put(
  "/script",
  describeRoute({
    tags: ["Sign"],
    summary: "Push a Rhai script to the signs",
    description:
      "Validates the script with the same Rhai engine the firmware runs, stores it as the fleet's desired state, and pushes it to every connected sign. Storing succeeds with zero signs online — the script replays to each sign as it connects.",
    security: bearerSecurity,
    responses: {
      200: jsonResponse("The script was stored and pushed.", SignScriptPushResponseSchema),
      400: jsonResponse("Invalid request body.", ErrorResponseSchema),
      401: errorResponses[401],
      422: jsonResponse("The script failed validation.", SignScriptRejectedSchema),
      500: errorResponses[500],
    },
  }),
  requireBearer,
  validator("json", SignSetScriptRequestSchema, rejectInvalidBody),
  async (c): Promise<Response> => {
    const { script } = c.req.valid("json");

    const validation = decodeJson(ValidationResultSchema, validate(script));
    if (validation.isErr()) {
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
    if (!validation.value.ok || validation.value.artifact === undefined) {
      return Response.json(
        {
          error: validation.value.error ?? "Invalid script",
          line: validation.value.line,
          col: validation.value.col,
        },
        { status: 422 },
      );
    }

    const pushed = await signService.setScript(script, validation.value.artifact);
    return pushed.match({
      ok: ({ connected }): Response => Response.json({ ok: true, connected }),
      err: errorResponse,
    });
  },
);

sign.delete(
  "/script",
  describeRoute({
    tags: ["Sign"],
    summary: "Delete the stored script",
    description:
      "Removes the stored script and reverts every connected sign to Lightning Time. Works with zero signs online — the deletion applies as each sign reconnects.",
    security: bearerSecurity,
    responses: {
      200: jsonResponse("The script was deleted.", OkResponseSchema),
      401: errorResponses[401],
      500: errorResponses[500],
    },
  }),
  requireBearer,
  () =>
    signService.clearScript().then(
      Result.match({
        ok: (): Response => Response.json({ ok: true }),
        err: errorResponse,
      }),
    ),
);

export default sign;
