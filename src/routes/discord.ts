import { Result } from "better-result";
import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { bearerAuth } from "hono/bearer-auth";

import { env } from "../env";
import {
  ErrorResponseSchema,
  jsonResponse,
  OkResponseSchema,
  rejectInvalidBody,
  WEBSOCKET_RESPONSES,
} from "../lib/openapi";
import { socketRoute } from "../lib/ws";
import { DiscordMessageSchema } from "../protocol/discord";
import * as discordService from "../services/discord";

const discord = new Hono();

discord.get(
  "/bot",
  describeRoute({
    tags: ["Discord"],
    summary: "Discord bot WebSocket",
    description:
      "WebSocket endpoint for the Discord bot. The first frame must be `{ token }`; later frames are Discord messages relayed to dashboards.",
    responses: WEBSOCKET_RESPONSES,
  }),
  ...socketRoute({
    connect: (ws): discordService.DiscordBotConnection => ({ ws, authenticated: false }),
    message: (connection, data) => discordService.handleBotMessage(connection, data),
  }),
);

discord.post(
  "/bot",
  describeRoute({
    tags: ["Discord"],
    summary: "Publish a Discord message to dashboards",
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse("The message was broadcast.", OkResponseSchema),
      400: jsonResponse("Invalid request body.", ErrorResponseSchema),
      401: { description: "Missing or invalid bearer token." },
      500: { description: "The control plane is unreachable." },
    },
  }),
  bearerAuth({ token: env.PHACK_API_KEY }),
  validator("json", DiscordMessageSchema, rejectInvalidBody),
  (c) =>
    discordService.broadcastMessage(c.req.valid("json")).then(
      Result.match({
        ok: (): Response => Response.json({ ok: true }),
        err: (): Response => Response.json({ error: "Internal server error" }, { status: 500 }),
      }),
    ),
);

discord.get(
  "/dashboard",
  describeRoute({
    tags: ["Discord"],
    summary: "Discord dashboard WebSocket",
    description:
      "Receive-only WebSocket feed of Discord messages. No authentication. On connect, the server replays the last 20 messages, oldest first, before streaming live ones.",
    responses: WEBSOCKET_RESPONSES,
  }),
  ...socketRoute({
    connect: (ws) => discordService.connectDashboard(ws),
    close: (connection) => discordService.disconnectDashboard(connection),
  }),
);

export default discord;
