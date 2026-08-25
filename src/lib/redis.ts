/**
 * @fileoverview Redis control plane. WebSocket connections stay on the
 * function instance that accepted them, so shared state, presence, and
 * cross-instance fan-out live in Redis (Upstash on Vercel). One client
 * runs commands and publishes. A second, dedicated client holds the
 * subscriptions, because a subscribed connection accepts no other
 * commands.
 */

import { Result, TaggedError } from "better-result";
import { createClient } from "redis";

import { env } from "../env";

/** Redis rejected a command or publish, or the connection failed. */
export class RedisCommandFailed extends TaggedError("RedisCommandFailed")<{
  cause: unknown;
  message: string;
}> {}

/** Captures a Redis operation's rejection as a typed Result. */
export function runRedis<T>(run: () => Promise<T>): Promise<Result<T, RedisCommandFailed>> {
  return Result.tryPromise({
    try: run,
    catch: (cause) => new RedisCommandFailed({ cause, message: "Redis command failed" }),
  });
}

function logRedisError(error: RedisCommandFailed): void {
  console.error(error.message, error.cause);
}

/** Command and publish connection. The client reconnects itself. */
export const redis = createClient({ url: env.REDIS_URL });

const subscriber = redis.duplicate();

redis.on("error", (cause: unknown) => {
  console.error("Redis client error", cause);
});
subscriber.on("error", (cause: unknown) => {
  console.error("Redis subscriber error", cause);
});

(await runRedis(() => redis.connect())).tapError(logRedisError);
(await runRedis(() => subscriber.connect())).tapError(logRedisError);

/**
 * Subscribes this instance to a control-plane channel. Services call this
 * once at module load. The caller logs a subscription failure because
 * the instance would silently miss every broadcast.
 */
export async function subscribeToChannel(
  channel: string,
  handler: (message: string) => void,
): Promise<Result<void, RedisCommandFailed>> {
  const subscription = await runRedis(() => subscriber.subscribe(channel, handler));
  return subscription.map(() => undefined);
}

const PRESENCE_FRESH_MS = 90_000;

/** How often each instance refreshes the presence entries it owns. */
export const PRESENCE_HEARTBEAT_MS = 30_000;

/** Marks a member of a presence roster as alive right now. */
export function touchPresence(
  key: string,
  member: string,
): Promise<Result<void, RedisCommandFailed>> {
  return runRedis(() => redis.zAdd(key, { score: Date.now(), value: member })).then(
    Result.map(() => undefined),
  );
}

/** Removes a member from a presence roster. */
export function removePresence(
  key: string,
  member: string,
): Promise<Result<void, RedisCommandFailed>> {
  return runRedis(() => redis.zRem(key, member)).then(Result.map(() => undefined));
}

/** Counts roster members that sent a heartbeat within the fresh window. */
export function countPresence(key: string): Promise<Result<number, RedisCommandFailed>> {
  return runRedis(() => redis.zCount(key, Date.now() - PRESENCE_FRESH_MS, "+inf")).then(
    Result.map((count) => Number(count ?? 0)),
  );
}

/** Lists roster members that sent a heartbeat within the fresh window. */
export function listPresence(key: string): Promise<Result<string[], RedisCommandFailed>> {
  return runRedis(() => redis.zRangeByScore(key, Date.now() - PRESENCE_FRESH_MS, "+inf")).then(
    Result.map((members) => members ?? []),
  );
}
