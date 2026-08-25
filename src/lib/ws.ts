/**
 * @fileoverview Boundary helpers for WebSocket routes and frames. Every
 * protocol in this API speaks JSON text. These helpers move frame
 * decoding and the upgrade/connection lifecycle into one place.
 */

import { createNodeWebSocket } from "@hono/node-ws";
import { Result, TaggedError } from "better-result";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { WSContext, WSMessageReceive } from "hono/ws";
import { json, z } from "zod";

/**
 * The Hono app lives here so `createNodeWebSocket` can bind to it before
 * the route modules ask for `upgradeWebSocket`. `src/app.ts` registers
 * the routes and owns the HTTP server.
 */
export const app = new Hono();

const nodeWebSocket = createNodeWebSocket({ app });

const { upgradeWebSocket } = nodeWebSocket;

/** Wires WebSocket upgrade handling into the app's HTTP server. */
export function injectWebSocket(server: Parameters<typeof nodeWebSocket.injectWebSocket>[0]): void {
  nodeWebSocket.injectWebSocket(server);
}

/** The frame payload is a kind this API cannot decode as text. */
export class UnreadableFrame extends TaggedError("UnreadableFrame")<{
  message: string;
}> {}

/** The text is not valid JSON or does not match the expected schema. */
export class InvalidJson extends TaggedError("InvalidJson")<{
  message: string;
}> {}

const TextFrameSchema = z.string();
const JsonValueSchema = json();

/** A value produced by parsing JSON text. */
export type JsonValue = z.output<typeof JsonValueSchema>;

/**
 * Reads a WebSocket frame as text. Binary frames decode as UTF-8.
 * Returns `UnreadableFrame` for payload kinds Bun never delivers.
 */
export function readFrameText(data: WSMessageReceive): Result<string, UnreadableFrame> {
  const text = TextFrameSchema.safeParse(data);
  if (text.success) {
    return Result.ok(text.data);
  }

  if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
    return Result.ok(new TextDecoder().decode(data));
  }

  return Result.err(new UnreadableFrame({ message: "Unsupported frame payload" }));
}

function parseJson(text: string): Result<JsonValue, InvalidJson> {
  return Result.try({
    try: () => JsonValueSchema.safeParse(JSON.parse(text)),
    catch: () => new InvalidJson({ message: "Invalid JSON" }),
  }).andThen((validation) =>
    validation.success
      ? Result.ok(validation.data)
      : Result.err(new InvalidJson({ message: "Invalid JSON" })),
  );
}

/** Parses JSON text without throwing and validates it with `schema`. */
export function decodeJson<S extends z.ZodType>(
  schema: S,
  text: string,
): Result<z.output<S>, InvalidJson> {
  return parseJson(text).andThen((value): Result<z.output<S>, InvalidJson> => {
    const validation = schema.safeParse(value);
    return validation.success
      ? Result.ok(validation.data)
      : Result.err(new InvalidJson({ message: "Invalid message" }));
  });
}

type SocketHooks<C> = {
  connect: (ws: WSContext) => C;
  message?: (connection: C, data: WSMessageReceive) => Promise<void>;
  close?: (connection: C) => Promise<void> | void;
};

/**
 * Builds the handler pair for a WebSocket route: the upgrade middleware
 * wired to the given lifecycle hooks, and a 426 fallback for plain HTTP
 * requests. `connect` runs synchronously so the first frame is never
 * lost.
 */
export function socketRoute<C>(hooks: SocketHooks<C>): MiddlewareHandler[] {
  return [
    upgradeWebSocket(() => {
      let connection: C | undefined;
      return {
        onOpen(_openEvent, ws) {
          connection = hooks.connect(ws);
        },
        async onMessage(event) {
          if (connection !== undefined) {
            await hooks.message?.(connection, event.data);
          }
        },
        async onClose() {
          if (connection !== undefined) {
            await hooks.close?.(connection);
          }
        },
      };
    }),
    async (c) => c.text("Expected websocket upgrade", 426),
  ];
}
