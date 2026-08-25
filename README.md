# Purdue Hackers API

Coordination server for managing Purdue Hackers hardware and systems. Controls doorbells, phones, Discord message feeds, and event attendance tracking — all through a unified REST + WebSocket API.

Built with [Hono](https://hono.dev) on Bun, deployed as a single [Vercel Function](https://vercel.com/docs/functions) with [WebSocket support](https://vercel.com/docs/functions/websockets). Durable data lives in [Turso](https://turso.tech) via [Drizzle](https://orm.drizzle.team); realtime coordination state lives in Redis ([Upstash](https://vercel.com/marketplace/upstash) on Vercel).

## Getting started

```bash
bun install
cp .env.example .env    # TURSO_DATABASE_URL=file:local.db and REDIS_URL=redis://localhost:6379 work for local dev
bun run db:migrate
redis-server --daemonize yes   # or: brew services start redis
bun dev
```

The server runs at `http://localhost:3000`. The OpenAPI spec is generated from the route annotations ([hono-openapi](https://hono.dev/examples/hono-openapi)) and served at `/openapi`.

| Command               | Description                      |
| --------------------- | -------------------------------- |
| `bun dev`             | Run with hot reload              |
| `bun run lint`        | Lint with oxlint                 |
| `bun run format`      | Format with oxfmt                |
| `bun run typecheck`   | Type-check with tsc              |
| `bun run db:generate` | Generate Drizzle migrations      |
| `bun run db:migrate`  | Apply migrations to the database |

Environment variables are listed in [`.env.example`](.env.example). Domain rules (the phone call model, device keys, dial plan) live in [`AGENTS.md`](AGENTS.md).

## Project layout

```
src/
├── server.ts    # Bun.serve() entrypoint
├── app.ts       # Hono app + OpenAPI spec route
├── routes/      # Endpoints, annotated with hono-openapi
├── services/    # WebSocket coordination per subsystem (Redis control plane)
├── protocol/    # Zod schemas for HTTP bodies and WS messages
├── lib/         # Turso-backed logic and shared helpers
└── db/          # Drizzle client, schema, migrations
```

WebSocket connections stay on the function instance that accepted them (data plane). Shared state, presence rosters, and cross-instance fan-out go through Redis pub/sub (control plane), so clients on different instances still see each other. Attendance data is durable in Turso.

## Deploying

`vercel.ts` configures the [Bun runtime](https://vercel.com/docs/functions/runtimes/bun) and `maxDuration: "max"`; Vercel detects the `Bun.serve()` call in `src/server.ts` and routes everything — WebSockets included — through one function.

```bash
vercel deploy
```

Attach [Upstash Redis from the Vercel Marketplace](https://vercel.com/marketplace/upstash) (its `REDIS_URL` is the `rediss://` connection string), set the remaining environment variables, and run `bun run db:migrate` once against the Turso database.
