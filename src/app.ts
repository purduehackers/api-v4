import { Hono } from "hono";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";

import { HealthResponseSchema, jsonResponse } from "./lib/openapi";
import attendance from "./routes/attendance";
import discord from "./routes/discord";
import doorbell from "./routes/doorbell";
import phonebell from "./routes/phonebell";

const app = new Hono();

app.get(
  "/",
  describeRoute({
    tags: ["Meta"],
    summary: "Health check",
    responses: {
      200: jsonResponse("API information.", HealthResponseSchema),
    },
  }),
  () =>
    Response.json({
      ok: true,
      readme: "Welcome to the Purdue Hackers API!",
      version: 4,
    }),
);

app.route("/attendance", attendance);
app.route("/discord", discord);
app.route("/doorbell", doorbell);
app.route("/phonebell", phonebell);

app.get(
  "/openapi",
  openAPIRouteHandler(app, {
    documentation: {
      info: {
        title: "Purdue Hackers API",
        version: "4.0.0",
        description:
          "Coordination server for Purdue Hackers hardware: doorbell, phones, Discord message feed, and attendance tracking.",
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer" },
        },
      },
    },
    exclude: ["/openapi"],
  }),
);

export default app;
