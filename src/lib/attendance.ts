/**
 * @fileoverview Attendance topics and counters backed by Turso. Counts are
 * event-sourced: each increment or decrement inserts a delta row, and a
 * topic's count is the sum of its deltas.
 */

import { Result, TaggedError } from "better-result";
import { eq, sql } from "drizzle-orm";

import { db } from "../db";
import { attendanceEvents, attendanceTopics } from "../db/schema";
import type {
  AttendanceTopicCreateInput,
  AttendanceTopicSummary,
  AttendanceTopicUpdateInput,
} from "../protocol/attendance";

/** No topic exists with the requested id. */
export class AttendanceTopicNotFound extends TaggedError("AttendanceTopicNotFound")<{
  topicId: string;
  message: string;
}> {}

/** Another topic already uses the requested name. */
export class AttendanceTopicNameConflict extends TaggedError("AttendanceTopicNameConflict")<{
  message: string;
}> {}

/** The decrement would take the topic count below zero. */
export class AttendanceNegativeCount extends TaggedError("AttendanceNegativeCount")<{
  message: string;
}> {}

/** The database rejected a query. */
export class AttendanceQueryFailed extends TaggedError("AttendanceQueryFailed")<{
  cause: unknown;
  message: string;
}> {}

const summaryColumns = {
  id: attendanceTopics.id,
  name: attendanceTopics.name,
  description: attendanceTopics.description,
  createdAtMs: attendanceTopics.createdAtMs,
  updatedAtMs: attendanceTopics.updatedAtMs,
  count: sql<number>`coalesce(sum(${attendanceEvents.delta}), 0)`,
};

function summaryRows(topicId?: string) {
  return db
    .select(summaryColumns)
    .from(attendanceTopics)
    .leftJoin(attendanceEvents, eq(attendanceEvents.topicId, attendanceTopics.id))
    .where(topicId === undefined ? undefined : eq(attendanceTopics.id, topicId))
    .groupBy(
      attendanceTopics.id,
      attendanceTopics.name,
      attendanceTopics.description,
      attendanceTopics.createdAtMs,
      attendanceTopics.updatedAtMs,
    )
    .orderBy(attendanceTopics.createdAtMs);
}

function mapSummary(row: AttendanceTopicSummary): AttendanceTopicSummary {
  return {
    ...row,
    count: Number(row.count ?? 0),
    description: row.description ?? null,
  };
}

function isUniqueConstraintError(cause: unknown): boolean {
  // Drizzle wraps driver errors in DrizzleQueryError. The UNIQUE detail
  // only appears on the wrapped LibsqlError, so walk the cause chain.
  for (let error = cause; error instanceof Error; error = error.cause) {
    if (
      /unique/i.test(error.message) &&
      /attendance_topics\.name|UNIQUE constraint failed/i.test(error.message)
    ) {
      return true;
    }
  }

  return false;
}

function queryFailed(cause: unknown): AttendanceQueryFailed {
  return new AttendanceQueryFailed({ cause, message: "Attendance query failed" });
}

function runQuery<T>(run: () => Promise<T>): Promise<Result<T, AttendanceQueryFailed>> {
  return Result.tryPromise({ try: run, catch: queryFailed });
}

function uniqueOrQueryFailed(cause: unknown): AttendanceTopicNameConflict | AttendanceQueryFailed {
  return isUniqueConstraintError(cause)
    ? new AttendanceTopicNameConflict({ message: "Topic name already exists" })
    : queryFailed(cause);
}

/** Lists every topic with its current count, oldest first. */
export function listTopics(): Promise<Result<AttendanceTopicSummary[], AttendanceQueryFailed>> {
  return runQuery(() => summaryRows()).then(Result.map((rows) => rows.map(mapSummary)));
}

/** Reads one topic with its current count. */
export function getTopic(
  topicId: string,
): Promise<Result<AttendanceTopicSummary, AttendanceTopicNotFound | AttendanceQueryFailed>> {
  return Result.gen(async function* () {
    const rows = yield* Result.await(runQuery(() => summaryRows(topicId)));
    const summary = rows[0];
    if (summary === undefined) {
      return Result.err(new AttendanceTopicNotFound({ topicId, message: "Topic not found" }));
    }

    return Result.ok(mapSummary(summary));
  });
}

/** Creates a topic. Fails when the name is already taken. */
export function createTopic(
  input: AttendanceTopicCreateInput,
): Promise<
  Result<
    AttendanceTopicSummary,
    AttendanceTopicNotFound | AttendanceTopicNameConflict | AttendanceQueryFailed
  >
> {
  return Result.gen(async function* () {
    const now = Date.now();
    const id = crypto.randomUUID();

    yield* Result.await(
      Result.tryPromise({
        try: () =>
          db.insert(attendanceTopics).values({
            id,
            name: input.name,
            description: input.description ?? null,
            createdAtMs: now,
            updatedAtMs: now,
          }),
        catch: uniqueOrQueryFailed,
      }),
    );

    const topic = yield* Result.await(getTopic(id));
    return Result.ok(topic);
  });
}

/** Updates a topic's name and/or description. */
export function updateTopic(
  topicId: string,
  input: AttendanceTopicUpdateInput,
): Promise<
  Result<
    AttendanceTopicSummary,
    AttendanceTopicNotFound | AttendanceTopicNameConflict | AttendanceQueryFailed
  >
> {
  return Result.gen(async function* () {
    const current = yield* Result.await(getTopic(topicId));

    yield* Result.await(
      Result.tryPromise({
        try: () =>
          db
            .update(attendanceTopics)
            .set({
              name: input.name ?? current.name,
              description:
                input.description !== undefined ? input.description : current.description,
              updatedAtMs: Date.now(),
            })
            .where(eq(attendanceTopics.id, topicId)),
        catch: uniqueOrQueryFailed,
      }),
    );

    const topic = yield* Result.await(getTopic(topicId));
    return Result.ok(topic);
  });
}

/** Deletes a topic and all of its events. */
export function deleteTopic(
  topicId: string,
): Promise<Result<void, AttendanceTopicNotFound | AttendanceQueryFailed>> {
  return Result.gen(async function* () {
    yield* Result.await(getTopic(topicId));
    yield* Result.await(
      runQuery(() => db.delete(attendanceTopics).where(eq(attendanceTopics.id, topicId))),
    );
    return Result.ok(undefined);
  });
}

/** Increments a topic's count by one. */
export function incrementTopic(
  topicId: string,
): Promise<
  Result<{ topicId: string; count: number }, AttendanceTopicNotFound | AttendanceQueryFailed>
> {
  return Result.gen(async function* () {
    yield* Result.await(getTopic(topicId));

    yield* Result.await(
      runQuery(() =>
        db.insert(attendanceEvents).values({
          id: crypto.randomUUID(),
          topicId,
          delta: 1,
          occurredAtMs: Date.now(),
        }),
      ),
    );

    const count = yield* Result.await(readCurrentCount(topicId));
    return Result.ok({ topicId, count });
  });
}

/** Decrements a topic's count by one. The count can never go negative. */
export function decrementTopic(
  topicId: string,
): Promise<
  Result<
    { topicId: string; count: number },
    AttendanceTopicNotFound | AttendanceNegativeCount | AttendanceQueryFailed
  >
> {
  return Result.gen(async function* () {
    yield* Result.await(getTopic(topicId));

    const result = yield* Result.await(
      runQuery(() =>
        db.run(sql`
          INSERT INTO attendance_events (id, topic_id, delta, occurred_at_ms)
          SELECT ${crypto.randomUUID()}, ${topicId}, -1, ${Date.now()}
          WHERE (
            SELECT COALESCE(SUM(delta), 0)
            FROM attendance_events
            WHERE topic_id = ${topicId}
          ) > 0
        `),
      ),
    );

    if (result.rowsAffected === 0) {
      return Result.err(new AttendanceNegativeCount({ message: "Attendance cannot be negative" }));
    }

    const count = yield* Result.await(readCurrentCount(topicId));
    return Result.ok({ topicId, count });
  });
}

function readCurrentCount(topicId: string): Promise<Result<number, AttendanceQueryFailed>> {
  return runQuery(() =>
    db
      .select({ count: sql<number>`coalesce(sum(${attendanceEvents.delta}), 0)` })
      .from(attendanceEvents)
      .where(eq(attendanceEvents.topicId, topicId)),
  ).then(Result.map((rows) => Number(rows[0]?.count ?? 0)));
}
