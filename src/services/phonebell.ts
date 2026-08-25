/**
 * @fileoverview Coordinates the phone system over the Redis control
 * plane: two phones, the door opener, and a WebRTC signaling relay.
 * Phone state lives in Redis hashes keyed by phone type, so the state
 * machine works no matter which function instance holds which socket.
 * Outbound frames fan out over pub/sub and each instance forwards them
 * to its local sockets. State transitions are last-write-wins. With two
 * phones on human timescales that is acceptable.
 *
 * @see ../../AGENTS.md#phonebell-call-model
 */

import { Result, TaggedError } from "better-result";
import type { WSContext, WSMessageReceive } from "hono/ws";
import { z } from "zod";

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
import { PhoneIncomingMessageSchema } from "../protocol/phonebell";

/** No instance holds an authenticated door-opener socket. */
export class NoDoorOpenerConnected extends TaggedError("NoDoorOpenerConnected")<{
  message: string;
}> {}

const PHONE_TYPES = ["Inside", "Outside"] as const;
const PHONE_STATUSES = [
  "idle",
  "awaiting_user",
  "calling_others",
  "in_call",
  "awaiting_others",
] as const;
const PHONE_SOUNDS = ["None", "Dialtone", "Ringback", "Hangup", "DoorOpen", "DoorFailed"] as const;

export type PhoneType = (typeof PHONE_TYPES)[number];
export type PhoneStatus = (typeof PHONE_STATUSES)[number];
export type PhoneSound = (typeof PHONE_SOUNDS)[number];

export type PhoneConnection = {
  ws: WSContext;
  phoneType: PhoneType;
  authenticated: boolean;
};

export type DoorOpenerConnection = {
  id: string;
  ws: WSContext;
  authenticated: boolean;
};

export type SignalingConnection = {
  id: string;
  ws: WSContext;
};

type PhoneState = {
  authenticated: boolean;
  status: PhoneStatus;
  hookState: boolean;
  dialedNumber: string;
  inCall: boolean;
};

type PhoneFrame =
  | { type: "Ring"; state: boolean }
  | { type: "Mute"; state: boolean }
  | { type: "PlaySound"; sound: PhoneSound };

const RINGER_KEY = "phack:phonebell:ringer";
const FRAMES_CHANNEL = "phack:phonebell:frames";
const DOOR_OPENER_CHANNEL = "phack:phonebell:door-opener";
const SIGNALING_CHANNEL = "phack:phonebell:signaling";
const DOOR_OPENER_PRESENCE_KEY = "phack:presence:door-opener";

/** Phone state hashes expire unless a heartbeat refreshes them. */
const PHONE_STATE_TTL_S = 120;

const PhoneStatusSchema = z.enum(PHONE_STATUSES);

const FramesEventSchema = z.object({
  target: z.enum(PHONE_TYPES),
  frames: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("Ring"), state: z.boolean() }),
      z.object({ type: z.literal("Mute"), state: z.boolean() }),
      z.object({ type: z.literal("PlaySound"), sound: z.enum(PHONE_SOUNDS) }),
    ]),
  ),
});

const SignalingEventSchema = z.object({
  from: z.string(),
  text: z.string(),
});

/** @see ../../AGENTS.md#known-numbers */
const KNOWN_NUMBERS: readonly string[] = [
  "0",
  "7",
  "349",
  "4225",
  "34643664",
  "8675309",
  "47932786463439686262438634258447455587853896846",
];

const phones = new Set<PhoneConnection>();
const doorOpeners = new Set<DoorOpenerConnection>();
const signaling = new Set<SignalingConnection>();

function phoneStateKey(phoneType: PhoneType): string {
  return `phack:phone:${phoneType}`;
}

function logRedisError(error: RedisCommandFailed): void {
  console.error(error.message, error.cause);
}

/** Registers a phone socket. The phone authenticates with its first frame. */
export function connectPhone(ws: WSContext, phoneType: PhoneType): PhoneConnection {
  const connection: PhoneConnection = { ws, phoneType, authenticated: false };
  phones.add(connection);
  return connection;
}

/** Registers a door-opener socket. It authenticates with its first frame. */
export function connectDoorOpener(ws: WSContext): DoorOpenerConnection {
  const connection: DoorOpenerConnection = { id: crypto.randomUUID(), ws, authenticated: false };
  doorOpeners.add(connection);
  return connection;
}

/** Registers a WebRTC signaling socket. */
export function connectSignaling(ws: WSContext): SignalingConnection {
  const connection: SignalingConnection = { id: crypto.randomUUID(), ws };
  signaling.add(connection);
  return connection;
}

/** Removes a phone and ends the call when it was the last active caller. */
export async function disconnectPhone(connection: PhoneConnection): Promise<void> {
  phones.delete(connection);
  if (!connection.authenticated) {
    return;
  }

  const gone = await Result.gen(async function* () {
    const state = yield* Result.await(readState(connection.phoneType));
    yield* Result.await(runRedis(() => redis.del(phoneStateKey(connection.phoneType))));

    if (state.authenticated && state.inCall) {
      const callers = yield* Result.await(activeCallers());
      if (callers === 0) {
        yield* Result.await(setRinger(false));
      }
      yield* Result.await(broadcastStateChange());
    }

    return Result.ok(undefined);
  });
  gone.tapError(logRedisError);
}

/** Removes a disconnected door-opener socket. */
export async function disconnectDoorOpener(connection: DoorOpenerConnection): Promise<void> {
  doorOpeners.delete(connection);
  if (connection.authenticated) {
    (await removePresence(DOOR_OPENER_PRESENCE_KEY, connection.id)).tapError(logRedisError);
  }
}

/** Removes a disconnected signaling socket. */
export function disconnectSignaling(connection: SignalingConnection): void {
  signaling.delete(connection);
}

/**
 * Applies one phone frame. The first frame must equal the API key.
 * Later frames are `Dial` and `Hook` messages.
 */
export async function handlePhoneMessage(
  connection: PhoneConnection,
  data: WSMessageReceive,
): Promise<void> {
  const text = readFrameText(data);
  if (text.isErr()) {
    return;
  }

  if (!connection.authenticated) {
    if (text.value.trim() !== env.PHACK_API_KEY) {
      connection.ws.close(1008, "Invalid API key");
      return;
    }

    connection.authenticated = true;
    (await handlePhoneAuthenticated(connection.phoneType)).tapError(logRedisError);
    return;
  }

  const message = decodeJson(PhoneIncomingMessageSchema, text.value);
  if (message.isErr()) {
    return;
  }

  const handled =
    message.value.type === "Dial"
      ? await handleDial(connection.phoneType, message.value.number)
      : await handleHook(connection.phoneType, message.value.state);
  handled.tapError(logRedisError);
}

/**
 * Applies one door-opener frame. The only expected frame is the initial
 * API key.
 */
export async function handleDoorOpenerMessage(
  connection: DoorOpenerConnection,
  data: WSMessageReceive,
): Promise<void> {
  if (connection.authenticated) {
    return;
  }

  const text = readFrameText(data);
  if (text.isErr()) {
    return;
  }

  if (text.value.trim() !== env.PHACK_API_KEY) {
    connection.ws.close(1008, "Invalid API key");
    return;
  }

  connection.authenticated = true;
  (await touchPresence(DOOR_OPENER_PRESENCE_KEY, connection.id)).tapError(logRedisError);
}

/** Relays a signaling frame to every other signaling socket anywhere. */
export async function handleSignalingMessage(
  connection: SignalingConnection,
  data: WSMessageReceive,
): Promise<void> {
  const text = readFrameText(data);
  if (text.isErr()) {
    return;
  }

  const event = JSON.stringify({ from: connection.id, text: text.value });
  (await runRedis(() => redis.publish(SIGNALING_CHANNEL, event))).tapError(logRedisError);
}

/**
 * Sends `Open` to every authenticated door opener on every instance.
 * The call fails without a connected door opener.
 */
export function triggerDoorOpener(): Promise<
  Result<void, NoDoorOpenerConnected | RedisCommandFailed>
> {
  return Result.gen(async function* () {
    const openers = yield* Result.await(countPresence(DOOR_OPENER_PRESENCE_KEY));
    if (openers === 0) {
      return Result.err(
        new NoDoorOpenerConnected({ message: "No door-opener connected via WebSocket" }),
      );
    }

    yield* Result.await(runRedis(() => redis.publish(DOOR_OPENER_CHANNEL, "open")));
    return Result.ok(undefined);
  });
}

function handlePhoneAuthenticated(phoneType: PhoneType): Promise<Result<void, RedisCommandFailed>> {
  return Result.gen(async function* () {
    yield* Result.await(
      writeState(phoneType, {
        authenticated: true,
        status: "idle",
        hookState: true,
        dialedNumber: "",
        inCall: false,
      }),
    );
    yield* Result.await(broadcastStateChange());
    return Result.ok(undefined);
  });
}

function handleDial(
  phoneType: PhoneType,
  number: string,
): Promise<Result<void, RedisCommandFailed>> {
  return Result.gen(async function* () {
    const state = yield* Result.await(readState(phoneType));

    if (state.status === "in_call") {
      if (phoneType === "Inside" && number === "0") {
        yield* Result.await(openDoor());
      }
      return Result.ok(undefined);
    }

    if (state.status !== "idle") {
      return Result.ok(undefined);
    }

    state.dialedNumber += number;
    if (!KNOWN_NUMBERS.includes(state.dialedNumber)) {
      const dialed = state.dialedNumber;
      if (KNOWN_NUMBERS.some((value) => value.startsWith(dialed))) {
        yield* Result.await(writeState(phoneType, state));
        return Result.ok(undefined);
      }

      state.dialedNumber = "0";
    }

    if (state.hookState) {
      state.status = "awaiting_user";
      yield* Result.await(writeState(phoneType, state));
      yield* Result.await(publishFrames(phoneType, [{ type: "Ring", state: true }]));
      return Result.ok(undefined);
    }

    yield* Result.await(
      publishFrames(phoneType, [
        { type: "PlaySound", sound: "Ringback" },
        { type: "Mute", state: false },
      ]),
    );
    yield* Result.await(markCallingOthers(phoneType, state));
    return Result.ok(undefined);
  });
}

function openDoor(): Promise<Result<void, RedisCommandFailed>> {
  return triggerDoorOpener().then((triggered) =>
    triggered.match({
      ok: () => notifyInCallPhones("DoorOpen"),
      err: (error) => {
        console.error(error.message);
        return notifyInCallPhones("DoorFailed");
      },
    }),
  );
}

function handleHook(
  phoneType: PhoneType,
  hookState: boolean,
): Promise<Result<void, RedisCommandFailed>> {
  return Result.gen(async function* () {
    const state = yield* Result.await(readState(phoneType));
    state.hookState = hookState;
    yield* Result.await(writeState(phoneType, state));

    if (!hookState) {
      const callers = yield* Result.await(activeCallers());
      if (callers > 0) {
        yield* Result.await(publishStateFrames(phoneType, "None", false));
        state.inCall = true;
        state.status = "in_call";
        yield* Result.await(writeState(phoneType, state));
        yield* Result.await(setRinger(false));
        yield* Result.await(broadcastStateChange());
        return Result.ok(undefined);
      }

      switch (state.status) {
        case "idle":
          yield* Result.await(publishStateFrames(phoneType, "Dialtone", true));
          break;
        case "awaiting_user":
          yield* Result.await(publishStateFrames(phoneType, "Ringback", false));
          yield* Result.await(markCallingOthers(phoneType, state));
          break;
        case "calling_others":
          yield* Result.await(publishStateFrames(phoneType, "Ringback", false));
          break;
        case "in_call":
          yield* Result.await(publishStateFrames(phoneType, "None", false));
          break;
        case "awaiting_others":
          yield* Result.await(publishStateFrames(phoneType, "Hangup", false));
          break;
      }

      return Result.ok(undefined);
    }

    yield* Result.await(publishStateFrames(phoneType, "None", true));

    if (state.status === "idle" || state.status === "awaiting_user") {
      state.dialedNumber = "";
    } else {
      state.inCall = false;
      yield* Result.await(writeState(phoneType, state));
      yield* Result.await(setRinger(false));
      yield* Result.await(broadcastStateChange());
    }

    state.status = "idle";
    yield* Result.await(writeState(phoneType, state));
    return Result.ok(undefined);
  });
}

function markCallingOthers(
  phoneType: PhoneType,
  state: PhoneState,
): Promise<Result<void, RedisCommandFailed>> {
  return Result.gen(async function* () {
    state.status = "calling_others";
    state.inCall = true;
    yield* Result.await(writeState(phoneType, state));

    const callers = yield* Result.await(activeCallers());
    if (callers <= 1) {
      yield* Result.await(setRinger(true));
    }

    yield* Result.await(broadcastStateChange());
    return Result.ok(undefined);
  });
}

function broadcastStateChange(): Promise<Result<void, RedisCommandFailed>> {
  return Result.gen(async function* () {
    for (const phoneType of PHONE_TYPES) {
      const state = yield* Result.await(readState(phoneType));
      if (state.authenticated) {
        yield* Result.await(updatePhoneFromState(phoneType, state));
      }
    }

    return Result.ok(undefined);
  });
}

function updatePhoneFromState(
  phoneType: PhoneType,
  state: PhoneState,
): Promise<Result<void, RedisCommandFailed>> {
  return Result.gen(async function* () {
    const callers = yield* Result.await(activeCallers());

    switch (state.status) {
      case "idle": {
        if (!state.hookState) {
          break;
        }

        const ringer = yield* Result.await(readRinger());
        yield* Result.await(publishFrames(phoneType, [{ type: "Ring", state: ringer }]));
        break;
      }
      case "calling_others":
      case "awaiting_others":
        if (!state.hookState && callers > 1) {
          state.status = "in_call";
          yield* Result.await(writeState(phoneType, state));
          yield* Result.await(publishStateFrames(phoneType, "None", false));
        }
        break;
      case "in_call": {
        if (state.hookState || callers !== 1) {
          break;
        }

        const ringer = yield* Result.await(readRinger());
        if (ringer) {
          break;
        }

        state.status = "awaiting_others";
        yield* Result.await(writeState(phoneType, state));
        yield* Result.await(publishFrames(phoneType, [{ type: "PlaySound", sound: "Hangup" }]));
        break;
      }
      case "awaiting_user":
        break;
    }

    return Result.ok(undefined);
  });
}

function notifyInCallPhones(sound: PhoneSound): Promise<Result<void, RedisCommandFailed>> {
  return Result.gen(async function* () {
    for (const phoneType of PHONE_TYPES) {
      const state = yield* Result.await(readState(phoneType));
      if (state.authenticated && state.inCall) {
        yield* Result.await(publishFrames(phoneType, [{ type: "PlaySound", sound }]));
      }
    }

    return Result.ok(undefined);
  });
}

function activeCallers(): Promise<Result<number, RedisCommandFailed>> {
  return Result.gen(async function* () {
    let count = 0;
    for (const phoneType of PHONE_TYPES) {
      const state = yield* Result.await(readState(phoneType));
      if (state.authenticated && state.inCall) {
        count += 1;
      }
    }

    return Result.ok(count);
  });
}

function publishStateFrames(
  phoneType: PhoneType,
  sound: PhoneSound,
  muted: boolean,
): Promise<Result<void, RedisCommandFailed>> {
  return publishFrames(phoneType, [
    { type: "Ring", state: false },
    { type: "Mute", state: muted },
    { type: "PlaySound", sound },
  ]);
}

function publishFrames(
  phoneType: PhoneType,
  frames: PhoneFrame[],
): Promise<Result<void, RedisCommandFailed>> {
  const event = JSON.stringify({ target: phoneType, frames });
  return runRedis(() => redis.publish(FRAMES_CHANNEL, event)).then(Result.map(() => undefined));
}

function readState(phoneType: PhoneType): Promise<Result<PhoneState, RedisCommandFailed>> {
  return runRedis(() =>
    redis.hmGet(phoneStateKey(phoneType), [
      "authenticated",
      "status",
      "hookState",
      "dialedNumber",
      "inCall",
    ]),
  ).then(
    Result.map((fields) => {
      const status = PhoneStatusSchema.safeParse(fields[1]);
      return {
        authenticated: fields[0] === "1",
        status: status.success ? status.data : "idle",
        hookState: (fields[2] ?? "1") === "1",
        dialedNumber: fields[3] ?? "",
        inCall: fields[4] === "1",
      };
    }),
  );
}

function writeState(
  phoneType: PhoneType,
  state: PhoneState,
): Promise<Result<void, RedisCommandFailed>> {
  const key = phoneStateKey(phoneType);
  return runRedis(async () => {
    await redis.hSet(key, {
      authenticated: state.authenticated ? "1" : "0",
      status: state.status,
      hookState: state.hookState ? "1" : "0",
      dialedNumber: state.dialedNumber,
      inCall: state.inCall ? "1" : "0",
    });
    await redis.expire(key, PHONE_STATE_TTL_S);
  });
}

function readRinger(): Promise<Result<boolean, RedisCommandFailed>> {
  return runRedis(() => redis.exists(RINGER_KEY)).then(Result.map((count) => count === 1));
}

function setRinger(ringing: boolean): Promise<Result<void, RedisCommandFailed>> {
  return runRedis(async () => {
    if (ringing) {
      await redis.set(RINGER_KEY, "1");
      return;
    }
    await redis.del(RINGER_KEY);
  });
}

setInterval(() => {
  for (const phone of phones) {
    if (phone.authenticated) {
      void runRedis(() => redis.expire(phoneStateKey(phone.phoneType), PHONE_STATE_TTL_S));
    }
  }
  for (const opener of doorOpeners) {
    if (opener.authenticated) {
      void touchPresence(DOOR_OPENER_PRESENCE_KEY, opener.id);
    }
  }
}, PRESENCE_HEARTBEAT_MS);

(
  await subscribeToChannel(FRAMES_CHANNEL, (message) => {
    const event = decodeJson(FramesEventSchema, message);
    if (event.isErr()) {
      return;
    }

    for (const phone of phones) {
      if (phone.phoneType === event.value.target && phone.authenticated) {
        for (const frame of event.value.frames) {
          phone.ws.send(JSON.stringify(frame));
        }
      }
    }
  })
).tapError(logRedisError);

(
  await subscribeToChannel(DOOR_OPENER_CHANNEL, () => {
    for (const opener of doorOpeners) {
      if (opener.authenticated) {
        opener.ws.send(JSON.stringify({ type: "Open" }));
      }
    }
  })
).tapError(logRedisError);

(
  await subscribeToChannel(SIGNALING_CHANNEL, (message) => {
    const event = decodeJson(SignalingEventSchema, message);
    if (event.isErr()) {
      return;
    }

    for (const peer of signaling) {
      if (peer.id !== event.value.from) {
        peer.ws.send(event.value.text);
      }
    }
  })
).tapError(logRedisError);
