import { Result } from "better-result";
import { Hono } from "hono";
import { describeRoute } from "hono-openapi";

import {
  ErrorResponseSchema,
  jsonResponse,
  OkResponseSchema,
  WEBSOCKET_RESPONSES,
} from "../lib/openapi";
import { socketRoute } from "../lib/ws";
import { DoorbellStatusSchema } from "../protocol/doorbell";
import * as doorbellService from "../services/doorbell";

const doorbell = new Hono();

doorbell.get(
  "/",
  describeRoute({
    tags: ["Doorbell"],
    summary: "Doorbell WebSocket",
    description:
      "WebSocket endpoint for doorbell clients. The server sends `status` broadcasts; clients send `set`, `ping`, and `diagnostic` frames.",
    responses: WEBSOCKET_RESPONSES,
  }),
  ...socketRoute({
    connect: (ws) => doorbellService.connect(ws),
    message: (connection, data) => doorbellService.handleMessage(connection, data),
    close: (connection) => doorbellService.disconnect(connection),
  }),
);

doorbell.get(
  "/status",
  describeRoute({
    tags: ["Doorbell"],
    summary: "Get the doorbell state",
    responses: {
      200: jsonResponse("The current doorbell state.", DoorbellStatusSchema),
      500: jsonResponse("The control plane is unreachable.", ErrorResponseSchema),
    },
  }),
  () =>
    doorbellService.getStatus().then(
      Result.match({
        ok: (status): Response => Response.json(status),
        err: (): Response => Response.json({ error: "Internal server error" }, { status: 500 }),
      }),
    ),
);

doorbell.post(
  "/ring",
  describeRoute({
    tags: ["Doorbell"],
    summary: "Ring the doorbell",
    responses: {
      200: jsonResponse("The doorbell is now ringing.", OkResponseSchema),
      400: { description: "The doorbell is already ringing." },
      500: jsonResponse("The control plane is unreachable.", ErrorResponseSchema),
    },
  }),
  (c) =>
    doorbellService.ring().then(
      Result.match({
        ok: (): Response => Response.json({ ok: true }),
        err: (error): Response =>
          error.match({
            AlreadyRinging: (): Response => c.text(error.message, 400),
            RedisCommandFailed: (): Response =>
              Response.json({ error: "Internal server error" }, { status: 500 }),
          }),
      }),
    ),
);

export default doorbell;
