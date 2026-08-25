import { Result } from "better-result";
import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { describeRoute } from "hono-openapi";
import { bearerAuth } from "hono/bearer-auth";

import { env } from "../env";
import { WEBSOCKET_RESPONSES } from "../lib/openapi";
import { socketRoute } from "../lib/ws";
import * as phonebellService from "../services/phonebell";

function phoneSocket(phoneType: phonebellService.PhoneType): MiddlewareHandler[] {
  return socketRoute({
    connect: (ws) => phonebellService.connectPhone(ws, phoneType),
    message: (connection, data) => phonebellService.handlePhoneMessage(connection, data),
    close: (connection) => phonebellService.disconnectPhone(connection),
  });
}

const phonebell = new Hono();

phonebell.get(
  "/outside",
  describeRoute({
    tags: ["Phonebell"],
    summary: "Outside phone WebSocket",
    description:
      "WebSocket endpoint for the outside phone. The first frame must be the API key; later frames are `Dial` and `Hook` messages.",
    responses: WEBSOCKET_RESPONSES,
  }),
  ...phoneSocket("Outside"),
);

phonebell.get(
  "/inside",
  describeRoute({
    tags: ["Phonebell"],
    summary: "Inside phone WebSocket",
    description: "WebSocket endpoint for the inside phone. Same protocol as the outside phone.",
    responses: WEBSOCKET_RESPONSES,
  }),
  ...phoneSocket("Inside"),
);

phonebell.get(
  "/door-opener",
  describeRoute({
    tags: ["Phonebell"],
    summary: "Door-opener WebSocket",
    description:
      "WebSocket endpoint for the door-opener device. The first frame must be the API key; the device then receives `Open` commands.",
    responses: WEBSOCKET_RESPONSES,
  }),
  ...socketRoute({
    connect: (ws) => phonebellService.connectDoorOpener(ws),
    message: (connection, data) => phonebellService.handleDoorOpenerMessage(connection, data),
    close: (connection) => phonebellService.disconnectDoorOpener(connection),
  }),
);

phonebell.get(
  "/signaling",
  describeRoute({
    tags: ["Phonebell"],
    summary: "WebRTC signaling WebSocket",
    description: "Relays signaling frames between connected peers for peer-to-peer audio.",
    responses: WEBSOCKET_RESPONSES,
  }),
  ...socketRoute({
    connect: (ws) => phonebellService.connectSignaling(ws),
    message: (connection, data) => phonebellService.handleSignalingMessage(connection, data),
    close: (connection) => phonebellService.disconnectSignaling(connection),
  }),
);

phonebell.post(
  "/open",
  describeRoute({
    tags: ["Phonebell"],
    summary: "Trigger the door opener",
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: "The door opener received the `Open` command." },
      401: { description: "Missing or invalid bearer token." },
      500: { description: "No door opener is connected." },
    },
  }),
  bearerAuth({ token: env.PHACK_API_KEY }),
  (c) =>
    phonebellService.triggerDoorOpener().then(
      Result.match({
        ok: (): Response => c.body(null, 204),
        err: (error): Response => c.text(error.message, 500),
      }),
    ),
);

export default phonebell;
