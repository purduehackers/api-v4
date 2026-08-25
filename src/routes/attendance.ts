import { Result } from "better-result";
import { Hono } from "hono";
import { describeRoute, validator } from "hono-openapi";
import { createFactory } from "hono/factory";

import * as attendanceService from "../lib/attendance";
import { ErrorResponseSchema, jsonResponse, rejectInvalidBody } from "../lib/openapi";
import {
  AttendanceCountResponseSchema,
  AttendanceDeleteResponseSchema,
  AttendanceTopicCreateSchema,
  AttendanceTopicListResponseSchema,
  AttendanceTopicResponseSchema,
  AttendanceTopicUpdateSchema,
} from "../protocol/attendance";

const attendance = new Hono();

const errorResponses = {
  404: jsonResponse("Topic not found.", ErrorResponseSchema),
  409: jsonResponse("Topic name conflict, or the count cannot go negative.", ErrorResponseSchema),
  500: jsonResponse("Internal server error.", ErrorResponseSchema),
};

/** Maps every attendance service error to its HTTP response. */
function errorResponse(
  error:
    | attendanceService.AttendanceTopicNotFound
    | attendanceService.AttendanceTopicNameConflict
    | attendanceService.AttendanceNegativeCount
    | attendanceService.AttendanceQueryFailed,
): Response {
  switch (error._tag) {
    case "AttendanceTopicNotFound":
      return Response.json({ error: error.message }, { status: 404 });
    case "AttendanceTopicNameConflict":
    case "AttendanceNegativeCount":
      return Response.json({ error: error.message }, { status: 409 });
    case "AttendanceQueryFailed":
      return Response.json({ error: "Internal server error" }, { status: 500 });
  }
}

attendance.on(
  "GET",
  ["/", "/topics"],
  describeRoute({
    tags: ["Attendance"],
    summary: "List attendance topics",
    responses: {
      200: jsonResponse("Every topic with its current count.", AttendanceTopicListResponseSchema),
      500: errorResponses[500],
    },
  }),
  () =>
    attendanceService.listTopics().then(
      Result.match({
        ok: (topics): Response => Response.json({ topics }),
        err: errorResponse,
      }),
    ),
);

const createTopicHandlers = createFactory().createHandlers(
  describeRoute({
    tags: ["Attendance"],
    summary: "Create an attendance topic",
    responses: {
      201: jsonResponse("The created topic.", AttendanceTopicResponseSchema),
      400: jsonResponse("Invalid request body.", ErrorResponseSchema),
      409: errorResponses[409],
      500: errorResponses[500],
    },
  }),
  validator("json", AttendanceTopicCreateSchema, rejectInvalidBody),
  (c) =>
    attendanceService.createTopic(c.req.valid("json")).then(
      Result.match({
        ok: (topic): Response => Response.json({ topic }, { status: 201 }),
        err: errorResponse,
      }),
    ),
);

attendance.post("/", ...createTopicHandlers);
attendance.post("/topics", ...createTopicHandlers);

attendance.get(
  "/topics/:topicId",
  describeRoute({
    tags: ["Attendance"],
    summary: "Get one attendance topic",
    responses: {
      200: jsonResponse("The topic with its current count.", AttendanceTopicResponseSchema),
      404: errorResponses[404],
      500: errorResponses[500],
    },
  }),
  (c) =>
    attendanceService.getTopic(c.req.param("topicId")).then(
      Result.match({
        ok: (topic): Response => Response.json({ topic }),
        err: errorResponse,
      }),
    ),
);

attendance.on(
  ["PATCH", "PUT"],
  "/topics/:topicId",
  describeRoute({
    tags: ["Attendance"],
    summary: "Update an attendance topic",
    responses: {
      200: jsonResponse("The updated topic.", AttendanceTopicResponseSchema),
      400: jsonResponse("Invalid request body.", ErrorResponseSchema),
      ...errorResponses,
    },
  }),
  validator("json", AttendanceTopicUpdateSchema, rejectInvalidBody),
  (c) =>
    attendanceService.updateTopic(c.req.param("topicId"), c.req.valid("json")).then(
      Result.match({
        ok: (topic): Response => Response.json({ topic }),
        err: errorResponse,
      }),
    ),
);

attendance.delete(
  "/topics/:topicId",
  describeRoute({
    tags: ["Attendance"],
    summary: "Delete an attendance topic and its events",
    responses: {
      200: jsonResponse("The topic was deleted.", AttendanceDeleteResponseSchema),
      404: errorResponses[404],
      500: errorResponses[500],
    },
  }),
  (c) => {
    const topicId = c.req.param("topicId");
    return attendanceService.deleteTopic(topicId).then(
      Result.match({
        ok: (): Response => Response.json({ ok: true, topicId }),
        err: errorResponse,
      }),
    );
  },
);

attendance.on(
  ["GET", "POST"],
  "/topics/:topicId/increment",
  describeRoute({
    tags: ["Attendance"],
    summary: "Increment a topic's count by one",
    responses: {
      200: jsonResponse("The new count.", AttendanceCountResponseSchema),
      404: errorResponses[404],
      500: errorResponses[500],
    },
  }),
  (c) =>
    attendanceService.incrementTopic(c.req.param("topicId")).then(
      Result.match({
        ok: (result): Response =>
          Response.json({ ok: true, topicId: result.topicId, count: result.count }),
        err: errorResponse,
      }),
    ),
);

attendance.on(
  ["GET", "POST"],
  "/topics/:topicId/decrement",
  describeRoute({
    tags: ["Attendance"],
    summary: "Decrement a topic's count by one",
    responses: {
      200: jsonResponse("The new count.", AttendanceCountResponseSchema),
      ...errorResponses,
    },
  }),
  (c) =>
    attendanceService.decrementTopic(c.req.param("topicId")).then(
      Result.match({
        ok: (result): Response =>
          Response.json({ ok: true, topicId: result.topicId, count: result.count }),
        err: errorResponse,
      }),
    ),
);

export default attendance;
