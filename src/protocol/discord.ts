import { z } from "zod";

export const DiscordAuthMessageSchema = z
  .object({
    token: z.string(),
  })
  .meta({ description: "First WebSocket frame a Discord bot sends to authenticate." });

export const DiscordMessageSchema = z
  .object({
    id: z.string().meta({ description: "Discord message id." }),
    channel: z.object({
      id: z.string(),
      name: z.string(),
    }),
    author: z.object({
      id: z.string(),
      name: z.string(),
      avatarHash: z.string().nullable(),
    }),
    timestamp: z.iso.datetime({ offset: true }),
    content: z.object({
      markdown: z.string(),
      html: z.string(),
    }),
    attachments: z.array(z.string()).default([]).meta({ description: "Attachment URLs." }),
  })
  .meta({ description: "A Discord message relayed to dashboard clients." });

export type DiscordMessage = z.output<typeof DiscordMessageSchema>;
