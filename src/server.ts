/**
 * @fileoverview Server entrypoint. Vercel's Bun framework preset detects
 * this single `Bun.serve()` call and routes every request through it,
 * including WebSocket upgrades. Locally, `bun --hot src/server.ts` serves
 * the same app on port 3000.
 */

import { websocket } from "hono/bun";

import app from "./app";

const { fetch: handleRequest } = app;

const server = Bun.serve({
  /**
   * Hands Hono the exact server object, so `upgradeWebSocket` finds
   * `upgrade()` on Vercel's Bun shim and on a local Bun server alike.
   */
  fetch: (request, instance) => handleRequest(request, { server: instance }),
  websocket,
});
    }
    return handleRequest(request, { server: instance });
  },
  websocket,
});
  },
  websocket,
});

console.log(`Listening on ${server.url.href}`);
