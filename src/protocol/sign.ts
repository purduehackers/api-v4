/**
 * @fileoverview Zod schemas for the sign protocol: the WebSocket frames
 * the signs exchange with the server, plus the sign HTTP payloads. All
 * connected signs share one identity and mirror the same content.
 */

import { z } from "zod";

/**
 * Field-for-field the shape the firmware serializes from NVS
 * (`src/net/config.rs` in purduehackers/sign-firmware) — do not rename.
 */
export const WifiNetworkSchema = z.object({
  ssid: z.string(),
  password: z.string(),
  network_type: z.enum(["personal", "enterprise", "wep"]).default("personal"),
  enterprise_email: z.string().optional(),
  enterprise_username: z.string().optional(),
});

export type WifiNetwork = z.output<typeof WifiNetworkSchema>;

/** Frames a sign sends the server. */
export const SignDeviceMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth"),
    key: z.string(),
  }),
  z.object({
    type: z.literal("ping"),
  }),
  z.object({
    type: z.literal("pong"),
  }),
  z.object({
    type: z.literal("status"),
    version: z.string().nullish(),
    heap_free: z.number().nullish(),
    heap_largest: z.number().nullish(),
  }),
  z.object({
    type: z.literal("wifi_networks"),
    request_id: z.string(),
    networks: z.array(WifiNetworkSchema),
  }),
  z.object({
    type: z.literal("wifi_ack"),
    request_id: z.string(),
  }),
  z.object({
    type: z.literal("script_ack"),
    request_id: z.string(),
  }),
  z.object({
    type: z.literal("script_error"),
    // Present when replying to a set_script/clear_script push. Absent for
    // an asynchronous runtime error from an already-running script. The
    // firmware serializes missing values as null, so accept both.
    request_id: z.string().nullish(),
    message: z.string(),
    line: z.number().nullish(),
    position: z.number().nullish(),
  }),
  z.object({
    type: z.literal("script_done"),
  }),
]);

export type SignDeviceMessage = z.output<typeof SignDeviceMessageSchema>;

/** Frames the server sends the signs. */
export type SignRequestMessage =
  | { type: "get_wifi"; request_id: string }
  | { type: "set_wifi"; request_id: string; networks: WifiNetwork[] }
  // The artifact is base64 grain bytecode from the validator. The sign
  // never parses script text.
  | { type: "set_script"; request_id: string; artifact: string }
  | { type: "clear_script"; request_id: string };

export const SignSetWifiRequestSchema = z.object({
  networks: z.array(WifiNetworkSchema),
});

export const SignSetScriptRequestSchema = z.object({
  script: z.string().min(1),
});

export const SignStatusResponseSchema = z
  .object({ connected: z.number() })
  .meta({ description: "How many signs hold a live, authenticated connection." });

export const SignWifiResponseSchema = z
  .object({ networks: z.array(WifiNetworkSchema) })
  .meta({ description: "The networks stored on the signs." });

export const SignScriptResponseSchema = z
  .object({ script: z.string(), updatedAtMs: z.number() })
  .meta({ description: "The stored script every sign converges to." });

export const SignScriptPushResponseSchema = z
  .object({ ok: z.literal(true), connected: z.number() })
  .meta({ description: "The script was stored and pushed to every connected sign." });

export const SignScriptRejectedSchema = z
  .object({
    error: z.string(),
    line: z.number().optional(),
    col: z.number().optional(),
  })
  .meta({ description: "The script failed validation." });
