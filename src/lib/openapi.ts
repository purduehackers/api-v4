/**
 * @fileoverview hono-openapi helpers and the response schemas every
 * route shares.
 */

import type { ResponsesWithResolver } from "hono-openapi";
import { resolver } from "hono-openapi";
import { z } from "zod";

export const ErrorResponseSchema = z
  .object({ error: z.string() })
  .meta({ description: "Error payload." });

export const OkResponseSchema = z
  .object({ ok: z.literal(true) })
  .meta({ description: "Success acknowledgement." });

export const HealthResponseSchema = z
  .object({
    ok: z.literal(true),
    readme: z.string(),
    version: z.number(),
  })
  .meta({ description: "API health and version information." });

/** Shared responses entry for WebSocket endpoints. */
export const WEBSOCKET_RESPONSES = {
  426: { description: "The request is not a WebSocket upgrade." },
};

type SchemaInput = Parameters<typeof resolver>[0];

/** Builds a JSON response entry for `describeRoute` responses. */
export function jsonResponse(
  description: string,
  schema: SchemaInput,
): ResponsesWithResolver[string] {
  return {
    description,
    content: { "application/json": { schema: resolver(schema) } },
  };
}

/**
 * Validator hook that rejects invalid request bodies with the API's
 * standard 400 payload. A returned `Response` stops the request. No
 * return value lets the handler run.
 */
export function rejectInvalidBody(result: { success: boolean }): Response | undefined {
  if (!result.success) {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }
}
