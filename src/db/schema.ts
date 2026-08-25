import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const attendanceTopics = sqliteTable(
  "attendance_topics",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    description: text("description"),
    createdAtMs: integer("created_at_ms", { mode: "number" }).notNull(),
    updatedAtMs: integer("updated_at_ms", { mode: "number" }).notNull(),
  },
  (table) => [index("attendance_topics_name_idx").on(table.name)],
);

export const attendanceEvents = sqliteTable(
  "attendance_events",
  {
    id: text("id").primaryKey(),
    topicId: text("topic_id")
      .notNull()
      .references(() => attendanceTopics.id, { onDelete: "cascade" }),
    delta: integer("delta").notNull(),
    occurredAtMs: integer("occurred_at_ms", { mode: "number" }).notNull(),
  },
  (table) => [
    index("attendance_events_topic_id_idx").on(table.topicId),
    index("attendance_events_occurred_at_ms_idx").on(table.occurredAtMs),
    check("attendance_events_delta_check", sql`${table.delta} in (1, -1)`),
  ],
);
