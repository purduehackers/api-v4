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
  /**
   * Broadcasts that arrive while the replay backlog is still going out
   * queue here. `undefined` marks a live connection that receives
   * broadcasts directly.
   */
  pending?: string[];
};

const MESSAGES_CHANNEL = "phack:discord:messages";
const RECENT_KEY = "phack:discord:recent";

/** How many mirrored messages the replay buffer keeps for new clients. */
const RECENT_LIMIT = 20;

const dashboards = new Set<DiscordDashboardConnection>();

function logRedisError(error: RedisCommandFailed): void {
  console.error(error.message, error.cause);
}

/**
 * Registers a receive-only dashboard socket. The socket first receives
 * the replay buffer, oldest message first, and then live broadcasts.
 * Registration is synchronous so no broadcast is lost while the replay
 * buffer loads.
 */
export function connectDashboard(ws: WSContext): DiscordDashboardConnection {
  const connection: DiscordDashboardConnection = { ws, pending: [] };
  dashboards.add(connection);
  void replayRecent(connection);
  return connection;
}

async function replayRecent(connection: DiscordDashboardConnection): Promise<void> {
  const backlog = await runRedis(() => redis.lRange(RECENT_KEY, 0, RECENT_LIMIT - 1));
  backlog.tapError(logRedisError);

  const delivered = new Set<string>();
  for (const serialized of backlog.unwrapOr([]).toReversed()) {
    const message = decodeJson(DiscordMessageSchema, serialized);
    if (message.isErr()) {
      continue;
    }

    connection.ws.send(serialized);
    delivered.add(message.value.id);
  }

  // No awaits from here on, so no broadcast can slip in mid-flush. A
  // message published between the buffer read and this flush sits in
  // `pending` and may also be in the backlog, hence the id check.
  const pending = connection.pending ?? [];
  connection.pending = undefined;
  for (const serialized of pending) {
    const message = decodeJson(DiscordMessageSchema, serialized);
    if (message.isOk() && !delivered.has(message.value.id)) {
      connection.ws.send(serialized);
    }
  }
}

/** Removes a disconnected dashboard socket. */
export function disconnectDashboard(connection: DiscordDashboardConnection): void {
  dashboards.delete(connection);
}

/**
 * Publishes a validated message to every dashboard on every instance and
 * appends it to the replay buffer new clients receive on connect. The
 * caller handles authorization and validation.
 */
export function broadcastMessage(
  message: DiscordMessage,
): Promise<Result<void, RedisCommandFailed>> {
  const serialized = JSON.stringify(message);
  return runRedis(async () => {
    await redis.lPush(RECENT_KEY, serialized);
    await redis.lTrim(RECENT_KEY, 0, RECENT_LIMIT - 1);
    await redis.publish(MESSAGES_CHANNEL, serialized);
  });
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
      if (dashboard.pending === undefined) {
        dashboard.ws.send(serialized);
      } else {
        dashboard.pending.push(serialized);
      }
    }
  })
).tapError(logRedisError);
