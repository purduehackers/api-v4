# Purdue Hackers API

Coordination server for Purdue Hackers hardware: doorbell, phone system, Discord message feed, and attendance counters. It is a Hono app on Bun, deployed as one Vercel Function that also serves the WebSocket connections. Attendance data lives in Turso (libSQL) via Drizzle.

## Control plane

WebSocket connections stay on the function instance that accepted them (the data plane). Everything shared crosses Redis (Upstash on Vercel): the doorbell ringing flag, phone state hashes, the ringer flag, presence rosters (sorted sets with heartbeat timestamps), and pub/sub channels for every broadcast. An instance never writes to another instance's sockets directly. It publishes, and each instance forwards to its local sockets. Phone state is keyed by phone type, one device per type. Transitions are read-modify-write without locks, so concurrent events are last-write-wins. That is acceptable for two phones on human timescales.

## Phonebell call model

Two physical phones (Inside and Outside) connect over WebSocket and authenticate with `PHACK_API_KEY` as their first frame. Each phone type has one shared state record in Redis, so one device per type. Each phone moves through the statuses `idle`, `awaiting_user`, `calling_others`, `in_call`, and `awaiting_others`, driven by `Dial` and `Hook` frames. Off-hook dialing of a known number rings every other phone. When the last active caller hangs up or disconnects, the shared ringer turns off. While in a call, the Inside phone dials `0` to trigger the door opener. Audio flows peer-to-peer over WebRTC; the `/phonebell/signaling` sockets only relay signaling frames between peers.

## Known numbers

The dial plan accepts only the numbers listed in `KNOWN_NUMBERS` in `src/services/phonebell.ts`. Digits accumulate until they match a known number exactly. A dialed prefix of a known number waits for more digits. Anything else redirects to `0`, the operator number that rings all phones.

## Authentication

One shared secret, `PHACK_API_KEY`, authenticates every non-public client: the phones and door opener (first WebSocket frame), the Discord bot (auth frame over WebSocket, bearer token over HTTP), and `POST /phonebell/open`.

<!-- oxray:comments:start -->
## Error handling

- Return `Result.err` for expected failures that callers can handle.
- Define expected failures with `TaggedError`.
- Use `Result.try` for synchronous APIs that can throw.
- Use `Result.tryPromise` for asynchronous APIs that can reject.
- Use `Result.gen` and `Result.await` to compose fallible workflows.
- Use `panic` for defects and failed invariants.
- Do not use `throw`, `try/catch`, `Promise.reject`, or `.catch()`.
- Do not return nullable failure sentinels or hand-written result envelopes.
- Do not call `Result.unwrap` or `.unwrap()`.

## Comments and documentation

- Use JSDoc for exported functions and classes.
- Use JSDoc when a comment describes a function, class, method, accessor, or constructor.
- Explain constraints, side effects, failure behavior, or design reasons. Do not narrate the code.
- Use clear technical English that follows ASD-STE100 principles.
- Keep descriptive sentences at 25 words or fewer.
- Keep procedural sentences at 20 words or fewer.
- Use active voice and simple verb tenses.
- Keep each paragraph to one topic and six sentences or fewer.

### File overviews

Add a leading `@fileoverview` JSDoc block when a module has a broad API or complex control flow.
Explain the module boundary and the important flow. Do not list the exports.

### Domain knowledge

Put durable business rules, architecture decisions, invariants, and shared terminology in the nearest AGENTS.md.
Use a relative JSDoc reference such as `@see ../../AGENTS.md#retry-policy` near the affected code.
Maintain one project glossary for preferred domain terms when several names could describe the same concept.

### Comment exceptions

If the project permits suppressions, use only rule-specific `disable-line` or `disable-next-line` directives.
Add the `--` delimiter and a clear rationale of at least five words to each lint suppression.
Delete commented-out implementation code or move it to a JSDoc example.
If disabled code must remain, add `KEPT: <reason>` immediately before it.

If the ASD-STE100 skill is available, use it when you write or revise substantial documentation.

## Responding to lint diagnostics

- Apply the exact replacement when a diagnostic provides one.
- Run `oxlint --fix` for corrections that preserve runtime behavior.
- Review each change before you run `oxlint --fix-suggestions`.
- Replace diagnostic placeholders with project-specific names and types.
- Run Oxfmt and Oxlint after each correction.
<!-- oxray:comments:end -->
