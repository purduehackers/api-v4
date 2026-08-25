/**
 * @fileoverview Redis control plane. WebSocket connections stay on the
 * function instance that accepted them, so shared state, presence, and
 * cross-instance fan-out live in Redis (Upstash on Vercel). One client
 * runs commands and publishes. A second, dedicated client holds the
 * subscriptions, because a subscribed connection accepts no other
 * commands.
 */

import { Result, TaggedError } from "better-result";
import { RedisClient } from "bun";

import { env } from "../env";

/** Redis rejected a command or publish, or the connection failed. */
export class RedisCommandFailed extends TaggedError("RedisCommandFailed")<{
  cause: unknown;
  message: string;
}> {}

/** Command and publish connection. Connects lazily and reconnects itself. */
export const redis = new RedisClient(env.REDIS_URL);

const subscriber = new RedisClient(env.REDIS_URL);

/** Captures a Redis operation's rejection as a typed Result. */
export function runRedis<T>(run: () => Promise<T>): Promise<Result<T, RedisCommandFailed>> {
  return Result.tryPromise({
    try: run,
    catch: (cause) => new RedisCommandFailed({ cause, message: "Redis command failed" }),
  });
}

/**
 * Subscribes this instance to a control-plane channel. Services call this
 * once at module load. A subscription failure is fatal because the
 * instance would silently miss every broadcast.
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
  return runRedis(() => redis.send("ZADD", [key, String(Date.now()), member])).then(
    Result.map(() => undefined),
  );
}

/** Removes a member from a presence roster. */
export function removePresence(
  key: string,
  member: string,
): Promise<Result<void, RedisCommandFailed>> {
  return runRedis(() => redis.send("ZREM", [key, member])).then(Result.map(() => undefined));
}

/** Counts roster members that sent a heartbeat within the fresh window. */
export function countPresence(key: string): Promise<Result<number, RedisCommandFailed>> {
  return runRedis(() =>
    redis.send("ZCOUNT", [key, String(Date.now() - PRESENCE_FRESH_MS), "+inf"]),
  ).then(Result.map((count) => Number(count ?? 0)));
}
