/**
 * @fileoverview Server entrypoint in Bun's module-export style. Bun and
 * Vercel's Bun runtime run the default-exported server config. Both wire
 * the `websocket` handler to the underlying server, so `upgradeWebSocket`
 * can upgrade connections. Locally, `bun --hot src/server.ts` serves the
 * app on port 3000.
 */

import { websocket } from "hono/bun";

import app from "./app";

export default {
  fetch: app.fetch,
  websocket,
};
