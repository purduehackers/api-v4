import { z } from "zod";

export const PhoneIncomingMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("Dial"),
    number: z.string(),
  }),
  z.object({
    type: z.literal("Hook"),
    state: z.boolean(),
  }),
]);

export type PhoneIncomingMessage = z.output<typeof PhoneIncomingMessageSchema>;
