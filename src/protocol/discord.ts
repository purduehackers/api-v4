import { z } from "zod";

const embedMediaSchema = z.object({
  url: z.string().optional(),
  proxy_url: z.string().optional(),
  content_type: z.string().optional(),
  description: z.string().optional(),
});

const embedNameSchema = z.object({ name: z.string().optional() });

const discordEmbedSchema = z.object({
  type: z.string().optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  color: z.int().min(0).max(0xffffff).optional(),
  author: embedNameSchema.optional(),
  provider: embedNameSchema.optional(),
  footer: z.object({ text: z.string() }).optional(),
  fields: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  image: embedMediaSchema.optional(),
  thumbnail: embedMediaSchema.optional(),
  video: embedMediaSchema.optional(),
});

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
    embeds: z.array(discordEmbedSchema).default([]),
    embedRevision: z
      .int()
      .positive()
      .optional()
      .meta({ description: "Gateway receipt time in milliseconds for a change to the embeds." }),
  })
  .meta({ description: "A Discord message relayed to dashboard clients." });

export type DiscordMessage = z.output<typeof DiscordMessageSchema>;

export const DiscordFeedFrameSchema = DiscordMessageSchema.extend({
  updateOnly: z.literal(true).optional(),
});

export type DiscordFeedFrame = z.output<typeof DiscordFeedFrameSchema>;
