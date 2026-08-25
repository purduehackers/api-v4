/**
 * @fileoverview Request and response schemas for the attendance API.
 * hono-openapi generates the OpenAPI spec from these schemas and their
 * metadata.
 */

import { z } from "zod";

export const AttendanceTopicCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).meta({ description: "Unique topic name." }),
    description: z.string().max(1000).nullable().optional(),
  })
  .meta({ description: "Fields for a new attendance topic." });

export type AttendanceTopicCreateInput = z.output<typeof AttendanceTopicCreateSchema>;

export const AttendanceTopicUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().max(1000).nullable().optional(),
  })
  .refine((value) => value.name !== undefined || value.description !== undefined, {
    message: "At least one field is required",
  })
  .meta({ description: "Partial update for an attendance topic. At least one field is required." });

export type AttendanceTopicUpdateInput = z.output<typeof AttendanceTopicUpdateSchema>;

export const AttendanceTopicSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    description: z.string().nullable(),
    createdAtMs: z.number().meta({ description: "Creation time in Unix milliseconds." }),
    updatedAtMs: z.number().meta({ description: "Last update time in Unix milliseconds." }),
    count: z.number().meta({ description: "Current attendance count." }),
  })
  .meta({ description: "An attendance topic with its current count." });

export type AttendanceTopicSummary = z.output<typeof AttendanceTopicSchema>;

export const AttendanceTopicListResponseSchema = z.object({
  topics: z.array(AttendanceTopicSchema),
});

export const AttendanceTopicResponseSchema = z.object({
  topic: AttendanceTopicSchema,
});

export const AttendanceCountResponseSchema = z
  .object({
    ok: z.literal(true),
    topicId: z.uuid(),
    count: z.number(),
  })
  .meta({ description: "The topic count after an increment or decrement." });

export const AttendanceDeleteResponseSchema = z.object({
  ok: z.literal(true),
  topicId: z.uuid(),
});
