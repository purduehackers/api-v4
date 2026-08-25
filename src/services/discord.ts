/**
 * @fileoverview Relays Discord messages from an authenticated bot to
 * receive-only dashboard clients. Messages fan out over the Redis
 * control plane so dashboards on every function instance receive them.
 * Bot authentication stays socket-local.
 */

import type { Result } from "better-result";
import type { WSContext, WSMessageReceive } from "hono/ws";

import { env } from "../env";
import type { RedisCommandFailed } from "../lib/redis";
import { redis, runRedis, subscribeToChannel } from "../lib/redis";
import { decodeJson, readFrameText } from "../lib/ws";
import type { DiscordMessage } from "../protocol/discord";
import { DiscordAuthMessageSchema, DiscordMessageSchema } from "../protocol/discord";

export type DiscordBotConnection = {
  ws: WSContext;
  authenticated: boolean;
};

export type DiscordDashboardConnection = {
  ws: WSContext;
};

const MESSAGES_CHANNEL = "phack:discord:messages";

const dashboards = new Set<DiscordDashboardConnection>();

function logRedisError(error: RedisCommandFailed): void {
  console.error(error.message, error.cause);
}

/** Registers a receive-only dashboard socket. */
export function connectDashboard(ws: WSContext): DiscordDashboardConnection {
  const connection: DiscordDashboardConnection = { ws };
  dashboards.add(connection);
  return connection;
}

/** Removes a disconnected dashboard socket. */
export function disconnectDashboard(connection: DiscordDashboardConnection): void {
  dashboards.delete(connection);
}

/**
 * Publishes a validated message to every dashboard on every instance.
 * The caller handles authorization and validation.
 */
export function broadcastMessage(
  message: DiscordMessage,
): Promise<Result<void, RedisCommandFailed>> {
  return runRedis(() => redis.publish(MESSAGES_CHANNEL, JSON.stringify(message))).then(
    (published) => published.map(() => undefined),
  );
}

/**
 * Applies one bot frame. The first frame must carry the auth token.
 * Later frames are Discord messages relayed to every dashboard.
 */
export async function handleBotMessage(
  connection: DiscordBotConnection,
  data: WSMessageReceive,
): Promise<void> {
  const text = readFrameText(data);
  if (text.isErr()) {
    return;
  }

  if (!connection.authenticated) {
    authenticateBot(connection, text.value);
    return;
  }

  const message = decodeJson(DiscordMessageSchema, text.value);
  if (message.isErr()) {
    return;
  }

  (await broadcastMessage(message.value)).tapError(logRedisError);
}

function authenticateBot(connection: DiscordBotConnection, text: string): void {
  const auth = decodeJson(DiscordAuthMessageSchema, text);
  if (auth.isErr()) {
    return;
  }

  const accepted = auth.value.token === env.PHACK_API_KEY;
  connection.ws.send(JSON.stringify({ auth: accepted ? "complete" : "rejected" }));

  if (!accepted) {
    connection.ws.close(1008, "Invalid token");
    return;
  }

  connection.authenticated = true;
}

(
  await subscribeToChannel(MESSAGES_CHANNEL, (message) => {
    const event = decodeJson(DiscordMessageSchema, message);
    if (event.isErr()) {
      return;
    }

    const serialized = JSON.stringify(event.value);
    for (const dashboard of dashboards) {
      dashboard.ws.send(serialized);
    }
  })
).tapError(logRedisError);
