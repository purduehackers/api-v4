/**
 * @fileoverview Application entrypoint. Registers every route on the
 * shared Hono app, wires WebSocket upgrades into a Node HTTP server, and
 * exports that server for Vercel's Node runtime. Locally the server
 * listens itself. On Vercel the platform owns the listener.
 */

import { createServer } from "node:http";

import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";

import { HealthResponseSchema, jsonResponse } from "./lib/openapi";
import { app, injectWebSocket } from "./lib/ws";
import attendance from "./routes/attendance";
import discord from "./routes/discord";
import doorbell from "./routes/doorbell";
import phonebell from "./routes/phonebell";
import sign from "./routes/sign";

const meta = new Hono();

meta.get(
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

app.route("/", meta);
app.route("/attendance", attendance);
app.route("/discord", discord);
app.route("/doorbell", doorbell);
app.route("/phonebell", phonebell);
app.route("/sign", sign);

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

const server = createServer(getRequestListener(app.fetch));
injectWebSocket(server);

if (process.env.VERCEL === undefined) {
  server.listen(Number(process.env.PORT ?? 3000));
}

// oxlint-disable-next-line rayhanadev/filename-match-export -- Vercel resolves this filename as the Hono entrypoint and requires the HTTP server as its default export
export default server;
