/**
 * @fileoverview Sign coordination over the Redis control plane. Every
 * connected sign shares one identity and mirrors the same content. The
 * server drives the fleet with broadcast frames correlated by
 * `request_id`: wifi config and script pushes go to every sign. For
 * reads, the first reply wins. The HTTP handler that needs an answer may
 * not be on the instance holding a socket. Requests therefore fan out
 * over pub/sub and replies come back the same way.
 *
 * The current script is durable in the database and re-pushed to each
 * sign on connect, so a reconnected sign converges to the stored state.
 */

import { Result, TaggedError } from "better-result";
import { eq } from "drizzle-orm";
import type { WSContext, WSMessageReceive } from "hono/ws";
import { json, z } from "zod";

import { db } from "../db";
import { signScript } from "../db/schema";
import { env } from "../env";
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
import type { SignDeviceMessage, SignRequestMessage, WifiNetwork } from "../protocol/sign";
import { SignDeviceMessageSchema } from "../protocol/sign";

/** No instance holds an authenticated sign socket. */
export class SignNotConnected extends TaggedError("SignNotConnected")<{
  message: string;
}> {}

/** No sign replied within the request timeout. */
export class SignTimedOut extends TaggedError("SignTimedOut")<{
  message: string;
}> {}

/** No script is stored. */
export class SignScriptNotFound extends TaggedError("SignScriptNotFound")<{
  message: string;
}> {}

/** The database rejected a query. */
export class SignQueryFailed extends TaggedError("SignQueryFailed")<{
  cause: unknown;
  message: string;
}> {}

export type SignConnection = {
  id: string;
  ws: WSContext;
  authenticated: boolean;
};

const PRESENCE_KEY = "phack:presence:sign";
const REQUESTS_CHANNEL = "phack:sign:requests";
const REPLIES_CHANNEL = "phack:sign:replies";
const STATUS_KEY = "phack:sign:status";

/** The singleton row every sign converges to. */
const SCRIPT_ROW_ID = 1;

/** How long the fleet gets to answer a request, same as api-v3. */
const REQUEST_TIMEOUT_MS = 10_000;

const RequestEventSchema = z.object({
  frame: json(),
});

const ReplyEventSchema = z.object({
  requestId: z.string(),
  reply: json(),
});

const connections = new Set<SignConnection>();

/** Requests this instance is awaiting a sign reply for. */
const pending = new Map<string, (reply: SignDeviceMessage) => void>();

function logRedisError(error: RedisCommandFailed): void {
  console.error(error.message, error.cause);
}

function runDb<T>(run: () => Promise<T>): Promise<Result<T, SignQueryFailed>> {
  return Result.tryPromise({
    try: run,
    catch: (cause) => new SignQueryFailed({ cause, message: "Sign database query failed" }),
  });
}

function sendFrame(
  ws: WSContext,
  frame: SignRequestMessage | { type: "pong" } | { type: "error"; message: string },
): void {
  ws.send(JSON.stringify(frame));
}

/** Registers a sign socket. The sign authenticates with its first frame. */
export function connect(ws: WSContext): SignConnection {
  const connection: SignConnection = { id: crypto.randomUUID(), ws, authenticated: false };
  connections.add(connection);
  return connection;
}

/** Removes a disconnected sign socket. */
export async function disconnect(connection: SignConnection): Promise<void> {
  connections.delete(connection);
  if (connection.authenticated) {
    (await removePresence(PRESENCE_KEY, connection.id)).tapError(logRedisError);
  }
}

/** Applies one sign frame. */
export async function handleMessage(
  connection: SignConnection,
  data: WSMessageReceive,
): Promise<void> {
  const frame = readFrameText(data).andThen((text) => decodeJson(SignDeviceMessageSchema, text));
  if (frame.isErr()) {
    sendFrame(connection.ws, { type: "error", message: "Invalid JSON" });
    return;
  }

  const message = frame.value;

  if (message.type === "auth") {
    if (message.key !== env.PHACK_API_KEY) {
      sendFrame(connection.ws, { type: "error", message: "Invalid API key" });
      connection.ws.close(1008, "Invalid API key");
      return;
    }

    connection.authenticated = true;
    (await touchPresence(PRESENCE_KEY, connection.id)).tapError(logRedisError);
    await pushStoredScript(connection);
    return;
  }

  if (message.type === "ping") {
    sendFrame(connection.ws, { type: "pong" });
    return;
  }

  if (!connection.authenticated) {
    return;
  }

  switch (message.type) {
    case "status":
      (
        await runRedis(() =>
          redis.set(
            STATUS_KEY,
            JSON.stringify({ version: message.version ?? null, seenAtMs: Date.now() }),
          ),
        )
      ).tapError(logRedisError);
      break;
    case "wifi_networks":
    case "wifi_ack":
    case "script_ack":
      await publishReply(message.request_id, message);
      break;
    case "script_error":
      console.error(`Sign script error: ${message.message}`);
      if (message.request_id !== undefined) {
        await publishReply(message.request_id, message);
      }
      break;
    case "script_done":
      console.log("Sign script finished; the sign reverts to Lightning Time");
      break;
    case "pong":
      break;
  }
}

async function publishReply(requestId: string, reply: SignDeviceMessage): Promise<void> {
  (
    await runRedis(() => redis.publish(REPLIES_CHANNEL, JSON.stringify({ requestId, reply })))
  ).tapError(logRedisError);
}

/**
 * After auth the sign converges to the stored state: the current script
 * when one exists, otherwise an explicit clear. The clear matters for a
 * script deleted while the sign was offline.
 */
async function pushStoredScript(connection: SignConnection): Promise<void> {
  const stored = await runDb(() =>
    db.select().from(signScript).where(eq(signScript.id, SCRIPT_ROW_ID)).limit(1),
  );
  stored
    .tap((rows) => {
      const requestId = crypto.randomUUID();
      const row = rows[0];
      sendFrame(
        connection.ws,
        row === undefined
          ? { type: "clear_script", request_id: requestId }
          : { type: "set_script", request_id: requestId, script: row.script },
      );
    })
    .tapError((error) => console.error(error.message, error.cause));
}

/** How many signs hold a live, authenticated connection anywhere. */
export function countConnected(): Promise<Result<number, RedisCommandFailed>> {
  return countPresence(PRESENCE_KEY);
}

function broadcastFrame(frame: SignRequestMessage): Promise<Result<void, RedisCommandFailed>> {
  return runRedis(() => redis.publish(REQUESTS_CHANNEL, JSON.stringify({ frame }))).then(
    Result.map(() => undefined),
  );
}

/**
 * Broadcasts one request to every connected sign and resolves with the
 * first reply. The signs mirror each other, so any one answer stands for
 * the fleet.
 */
function requestFleet(
  createFrame: (requestId: string) => SignRequestMessage,
): Promise<Result<SignDeviceMessage, SignNotConnected | SignTimedOut | RedisCommandFailed>> {
  return Result.gen(async function* () {
    const connected = yield* Result.await(countConnected());
    if (connected === 0) {
      return Result.err(new SignNotConnected({ message: "No sign connected" }));
    }

    const requestId = crypto.randomUUID();
    const reply = new Promise<SignDeviceMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      pending.set(requestId, (message) => {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(message);
      });
    });

    yield* Result.await(broadcastFrame(createFrame(requestId)));

    const message = await reply;
    if (message === null) {
      return Result.err(new SignTimedOut({ message: "No sign responded" }));
    }
    return Result.ok(message);
  });
}

/** Asks the fleet for its stored WiFi networks. First reply wins. */
export function getWifi(): Promise<
  Result<WifiNetwork[], SignNotConnected | SignTimedOut | RedisCommandFailed>
> {
  return requestFleet((requestId) => ({ type: "get_wifi", request_id: requestId })).then((result) =>
    result.andThen((reply) =>
      reply.type === "wifi_networks"
        ? Result.ok(reply.networks)
        : Result.err(new SignTimedOut({ message: "No sign responded" })),
    ),
  );
}

/**
 * Replaces the WiFi networks on every connected sign. WiFi lives in each
 * sign's flash, not the database, so at least one sign must acknowledge.
 */
export function setWifi(
  networks: WifiNetwork[],
): Promise<Result<void, SignNotConnected | SignTimedOut | RedisCommandFailed>> {
  return requestFleet((requestId) => ({
    type: "set_wifi",
    request_id: requestId,
    networks,
  })).then((result) =>
    result.andThen((reply) =>
      reply.type === "wifi_ack"
        ? Result.ok(undefined)
        : Result.err(new SignTimedOut({ message: "No sign responded" })),
    ),
  );
}

/**
 * Stores the script as the fleet's desired state and pushes it to every
 * connected sign. Storing succeeds with zero signs online — the script
 * replays to each sign as it connects.
 */
export function setScript(
  script: string,
): Promise<Result<{ connected: number }, SignQueryFailed | RedisCommandFailed>> {
  return Result.gen(async function* () {
    yield* Result.await(
      runDb(() =>
        db
          .insert(signScript)
          .values({ id: SCRIPT_ROW_ID, script, updatedAtMs: Date.now() })
          .onConflictDoUpdate({
            target: signScript.id,
            set: { script, updatedAtMs: Date.now() },
          }),
      ),
    );

    const connected = yield* Result.await(countConnected());
    if (connected > 0) {
      yield* Result.await(
        broadcastFrame({
          type: "set_script",
          request_id: crypto.randomUUID(),
          script,
        }),
      );
    }
    return Result.ok({ connected });
  });
}

/** The stored script. */
export function getScript(): Promise<
  Result<{ script: string; updatedAtMs: number }, SignScriptNotFound | SignQueryFailed>
> {
  return Result.gen(async function* () {
    const rows = yield* Result.await(
      runDb(() => db.select().from(signScript).where(eq(signScript.id, SCRIPT_ROW_ID)).limit(1)),
    );
    const row = rows[0];
    if (row === undefined) {
      return Result.err(new SignScriptNotFound({ message: "No script set" }));
    }
    return Result.ok({ script: row.script, updatedAtMs: row.updatedAtMs });
  });
}

/**
 * Deletes the stored script and reverts every connected sign to
 * Lightning Time. The durable state changes even with zero signs online.
 */
export function clearScript(): Promise<Result<void, SignQueryFailed | RedisCommandFailed>> {
  return Result.gen(async function* () {
    yield* Result.await(runDb(() => db.delete(signScript).where(eq(signScript.id, SCRIPT_ROW_ID))));

    const connected = yield* Result.await(countConnected());
    if (connected > 0) {
      yield* Result.await(
        broadcastFrame({ type: "clear_script", request_id: crypto.randomUUID() }),
      );
    }
    return Result.ok(undefined);
  });
}

setInterval(() => {
  for (const connection of connections) {
    if (connection.authenticated) {
      void touchPresence(PRESENCE_KEY, connection.id);
    }
  }
}, PRESENCE_HEARTBEAT_MS);

(
  await subscribeToChannel(REQUESTS_CHANNEL, (message) => {
    const event = decodeJson(RequestEventSchema, message);
    if (event.isErr()) {
      return;
    }

    for (const connection of connections) {
      if (connection.authenticated) {
        connection.ws.send(JSON.stringify(event.value.frame));
      }
    }
  })
).tapError(logRedisError);

(
  await subscribeToChannel(REPLIES_CHANNEL, (message) => {
    const event = decodeJson(ReplyEventSchema, message);
    if (event.isErr()) {
      return;
    }

    const resolve = pending.get(event.value.requestId);
    if (resolve === undefined) {
      return;
    }

    const reply = SignDeviceMessageSchema.safeParse(event.value.reply);
    if (reply.success) {
      resolve(reply.data);
    }
  })
).tapError(logRedisError);
