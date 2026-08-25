import { z } from "zod";

export const DoorbellMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("set"),
    ringing: z.boolean(),
  }),
  z.object({
    type: z.literal("status"),
    ringing: z.boolean(),
  }),
  z.object({
    type: z.literal("ping"),
  }),
  z.object({
    type: z.literal("pong"),
  }),
  z.object({
    type: z.literal("diagnostic"),
    level: z.enum(["info", "warning", "error"]),
    kind: z.string(),
    message: z.string(),
  }),
]);

export type DoorbellMessage = z.output<typeof DoorbellMessageSchema>;

export const DoorbellStatusSchema = z
  .object({
    ringing: z.boolean(),
  })
  .meta({ description: "Current doorbell state." });
