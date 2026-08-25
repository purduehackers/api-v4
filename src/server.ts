/**
 * @fileoverview Server entrypoint. Vercel's Bun framework preset detects
 * this single `Bun.serve()` call and routes every request through it,
 * including WebSocket upgrades. Locally, `bun --hot src/server.ts` serves
 * the same app on port 3000.
 */

import { websocket } from "hono/bun";

import app from "./app";

const server = Bun.serve({
  fetch: app.fetch,
  websocket,
});

console.log(`Listening on ${server.url.href}`);
