/**
 * @fileoverview Doorbell coordination over the Redis control plane. The
 * ringing flag lives in Redis. Status changes fan out over pub/sub, and
 * every function instance forwards them to its local sockets. A presence
 * roster tracks connected clients across instances.
 */

import { Result, TaggedError } from "better-result";
import type { WSContext, WSMessageReceive } from "hono/ws";
import { z } from "zod";

import type { RedisCommandFailed } from "../lib/redis";
import {
  countPresence,
  PRESENCE_HEARTBEAT_MS,
  redis,
  removePresence,
  runRedis,
  subscribeToChannel,
  touchPresence,
} from "../lib/redis";
import { decodeJson, readFrameText } from "../lib/ws";
import type { DoorbellMessage } from "../protocol/doorbell";
import { DoorbellMessageSchema } from "../protocol/doorbell";

/** The doorbell is already in the ringing state. */
export class AlreadyRinging extends TaggedError("AlreadyRinging")<{
  message: string;
}> {}

export type DoorbellConnection = {
  id: string;
  ws: WSContext;
};

const RINGING_KEY = "phack:doorbell:ringing";
const EVENTS_CHANNEL = "phack:doorbell:events";
const PRESENCE_KEY = "phack:presence:doorbell";

const EventSchema = z.object({ ringing: z.boolean() });

const connections = new Set<DoorbellConnection>();

function logRedisError(error: RedisCommandFailed): void {
  console.error(error.message, error.cause);
}

function sendMessage(ws: WSContext, message: DoorbellMessage): void {
  ws.send(JSON.stringify(message));
}

/**
 * Registers a client synchronously so its first frame is never lost,
 * then reports presence and sends the current status in the background.
 */
export function connect(ws: WSContext): DoorbellConnection {
  const connection: DoorbellConnection = { id: crypto.randomUUID(), ws };
  connections.add(connection);
  void announce(connection);
  return connection;
}

/** Removes a disconnected client. */
export async function disconnect(connection: DoorbellConnection): Promise<void> {
  connections.delete(connection);
  (await removePresence(PRESENCE_KEY, connection.id)).tapError(logRedisError);
}

async function announce(connection: DoorbellConnection): Promise<void> {
  (await touchPresence(PRESENCE_KEY, connection.id)).tapError(logRedisError);
  (await readRinging())
    .tap((ringing) => {
      sendMessage(connection.ws, { type: "status", ringing });
    })
    .tapError(logRedisError);
}

/** Reads the shared ringing state. */
export function getStatus(): Promise<Result<{ ringing: boolean }, RedisCommandFailed>> {
  return readRinging().then(Result.map((ringing) => ({ ringing })));
}

/**
 * Starts ringing and notifies every client on every instance. The call
 * fails when the doorbell is already ringing.
 */
export function ring(): Promise<Result<void, AlreadyRinging | RedisCommandFailed>> {
  return Result.gen(async function* () {
    const claimed = yield* Result.await(
      runRedis(() => redis.send("SET", [RINGING_KEY, "1", "NX"])),
    );

    if (claimed === null) {
      return Result.err(new AlreadyRinging({ message: "Already ringing" }));
    }

    yield* Result.await(publishStatus(true));
    return Result.ok(undefined);
  });
}

/** Applies one client frame: `set` updates state, `ping` gets a `pong`. */
export async function handleMessage(
  connection: DoorbellConnection,
  data: WSMessageReceive,
): Promise<void> {
  const frame = readFrameText(data).andThen((text) => decodeJson(DoorbellMessageSchema, text));
  if (frame.isErr()) {
    return;
  }

  switch (frame.value.type) {
    case "set":
      (await setRinging(connection, frame.value.ringing)).tapError(logRedisError);
      break;
    case "ping":
      sendMessage(connection.ws, { type: "pong" });
      break;
    case "diagnostic":
    case "pong":
    case "status":
      break;
  }
}

function setRinging(
  connection: DoorbellConnection,
  ringing: boolean,
): Promise<Result<void, RedisCommandFailed>> {
  return Result.gen(async function* () {
    yield* Result.await(
      runRedis(async () => {
        if (ringing) {
          await redis.set(RINGING_KEY, "1");
          return;
        }
        await redis.del(RINGING_KEY);
      }),
    );

    const clients = yield* Result.await(countPresence(PRESENCE_KEY));
    if (clients <= 1) {
      sendMessage(connection.ws, {
        type: "diagnostic",
        level: "warning",
        kind: "NoClientsError",
        message: "No other clients are connected to the doorbell at the moment",
      });
      return Result.ok(undefined);
    }

    yield* Result.await(publishStatus(ringing));
    return Result.ok(undefined);
  });
}

function publishStatus(ringing: boolean): Promise<Result<void, RedisCommandFailed>> {
  return runRedis(() => redis.publish(EVENTS_CHANNEL, JSON.stringify({ ringing }))).then(
    Result.map(() => undefined),
  );
}

function readRinging(): Promise<Result<boolean, RedisCommandFailed>> {
  return runRedis(() => redis.exists(RINGING_KEY));
}

setInterval(() => {
  for (const connection of connections) {
    void touchPresence(PRESENCE_KEY, connection.id);
  }
}, PRESENCE_HEARTBEAT_MS);

(
  await subscribeToChannel(EVENTS_CHANNEL, (message) => {
    const event = decodeJson(EventSchema, message);
    if (event.isErr()) {
      return;
    }

    for (const connection of connections) {
      sendMessage(connection.ws, { type: "status", ringing: event.value.ringing });
    }
  })
).tapError(logRedisError);
