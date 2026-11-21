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
import {
  DiscordAuthMessageSchema,
  DiscordFeedFrameSchema,
  DiscordMessageSchema,
} from "../protocol/discord";

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

  const delivered = new Map<string, number>();
  for (const serialized of backlog.unwrapOr([]).toReversed()) {
    const message = decodeJson(DiscordMessageSchema, serialized);
    if (message.isErr()) {
      continue;
    }

    connection.ws.send(serialized);
    delivered.set(message.value.id, message.value.embedRevision ?? 0);
  }

  // No awaits from here on, so no broadcast can slip in mid-flush. A
  // message published between the buffer read and this flush sits in
  // `pending` and may also be in the backlog at the same revision.
  const pending = connection.pending ?? [];
  connection.pending = undefined;
  for (const serialized of pending) {
    const message = decodeJson(DiscordFeedFrameSchema, serialized);
    if (
      message.isOk() &&
      (delivered.get(message.value.id) ?? -1) < (message.value.embedRevision ?? 0)
    ) {
      connection.ws.send(serialized);
    }
  }
}

/** Removes a disconnected dashboard socket. */
export function disconnectDashboard(connection: DiscordDashboardConnection): void {
  dashboards.delete(connection);
}

// Keep replay and publication atomic across API instances. Discord can send a
// preview while the bot is still rendering or retrying the original message.
const STORE_AND_PUBLISH = `
  local recent, pending = KEYS[1], KEYS[2]
  local id, snapshot, revision, live, channel, limit = unpack(ARGV)
  revision = tonumber(revision)
  for index, entry in ipairs(redis.call('LRANGE', recent, 0, -1)) do
    local ok, stored = pcall(cjson.decode, entry)
    if ok and type(stored) == 'table' and stored.id == id then
      if revision > (stored.embedRevision or 0) then
        redis.call('LSET', recent, index - 1, snapshot)
        redis.call('PUBLISH', channel, live)
      end
      return
    end
  end
  if revision > 0 then
    local prior = redis.call('GET', pending)
    if not prior or revision > cjson.decode(prior).embedRevision then
      redis.call('SET', pending, snapshot, 'EX', 300)
      redis.call('PUBLISH', channel, live)
    end
    return
  end
  local original = redis.call('GET', pending) or snapshot
  redis.call('DEL', pending)
  redis.call('LPUSH', recent, original)
  redis.call('LTRIM', recent, 0, tonumber(limit) - 1)
  redis.call('PUBLISH', channel, original)
`;

/**
 * Stores each message once and publishes newer embed snapshots without moving its replay position.
 * @see ../../AGENTS.md#discord-dashboard-feed
 */
export function broadcastMessage(
  message: DiscordMessage,
): Promise<Result<void, RedisCommandFailed>> {
  const serialized = JSON.stringify(message);
  const live = message.embedRevision
    ? JSON.stringify({ ...message, updateOnly: true })
    : serialized;
  return runRedis(() =>
    redis.eval(STORE_AND_PUBLISH, {
      keys: [RECENT_KEY, `{${RECENT_KEY}}:pending:${message.id}`],
      arguments: [
        message.id,
        serialized,
        String(message.embedRevision ?? 0),
        live,
        MESSAGES_CHANNEL,
        String(RECENT_LIMIT),
      ],
    }),
  ).then((result) => result.map(() => undefined));
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
    const event = decodeJson(DiscordFeedFrameSchema, message);
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
