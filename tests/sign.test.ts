/**
 * @fileoverview End-to-end tests for the sign module: mock signs connect
 * over real WebSockets while the HTTP routes drive the fleet. Needs a
 * local Redis (default redis://127.0.0.1:6379, override with
 * TEST_REDIS_URL).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8135;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "test-key";

process.env.TURSO_DATABASE_URL = `file:${join(mkdtempSync(join(tmpdir(), "sign-test-")), "sign.db")}`;
process.env.REDIS_URL =
  process.env.TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
process.env.PHACK_API_KEY = API_KEY;
process.env.PORT = String(PORT);
process.env.SIGN_REPLAY_DELAY_MS = "100";
process.env.SIGN_FRAME_POLL_MS = "150";
delete process.env.VERCEL;

const { createClient } = await import("@libsql/client");
const dbClient = createClient({ url: process.env.TURSO_DATABASE_URL });
await dbClient.execute(
  "CREATE TABLE IF NOT EXISTS sign_script (id integer PRIMARY KEY, script text NOT NULL, artifact text, updated_at_ms integer NOT NULL)",
);

const { redis } = await import("../src/lib/redis");
await redis.flushAll();

const { default: server } = await import("../src/app");

type Frame = Record<string, unknown>;

/** A fake firmware: collects frames and lets tests await specific ones. */
class MockSign {
  private ws: WebSocket;
  private frames: Frame[] = [];
  private waiters: Array<{ matches: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> =
    [];
  closed: Promise<{ code: number }>;

  private constructor(ws: WebSocket, closed: Promise<{ code: number }>) {
    this.ws = ws;
    this.closed = closed;
    ws.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as Frame;
      const index = this.waiters.findIndex((waiter) => waiter.matches(frame));
      if (index >= 0) {
        const [waiter] = this.waiters.splice(index, 1);
        waiter?.resolve(frame);
        return;
      }
      this.frames.push(frame);
    });
  }

  static async connect(): Promise<MockSign> {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/sign/ws`);
    let reportClose: (value: { code: number }) => void = () => {};
    const closed = new Promise<{ code: number }>((resolve) => {
      reportClose = resolve;
    });
    ws.addEventListener("close", (event) => reportClose({ code: event.code }));
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", () => reject(new Error("WebSocket failed to connect")));
    });
    return new MockSign(ws, closed);
  }

  /** Connects and authenticates, consuming the state-replay frame. */
  static async connectAuthenticated(): Promise<MockSign> {
    const mock = await MockSign.connect();
    mock.send({ type: "auth", key: API_KEY });
    // The server converges every new sign: a stored script or a clear.
    await mock.nextAny(["set_script", "clear_script"]);
    return mock;
  }

  send(frame: Frame): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Resolves with the next frame matching `type`, buffered or future. */
  next(type: string, timeoutMs = 5000): Promise<Frame> {
    return this.nextAny([type], timeoutMs);
  }

  /** Resolves with the next frame whose type is in `types`. */
  nextAny(types: string[], timeoutMs = 5000): Promise<Frame> {
    const index = this.frames.findIndex((frame) => types.includes(String(frame["type"])));
    if (index >= 0) {
      const [frame] = this.frames.splice(index, 1);
      return Promise.resolve(frame as Frame);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        matches: (frame: Frame) => types.includes(String(frame["type"])),
        resolve: (frame: Frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((candidate) => candidate !== waiter);
        reject(new Error(`Timed out waiting for a ${types.join("/")} frame`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  close(): void {
    this.ws.close();
  }
}

type ApiInit = { method?: string; body?: string; headers?: Record<string, string> };

function api(path: string, init: ApiInit = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

async function connectedCount(): Promise<number> {
  const response = await api("/sign/status");
  return ((await response.json()) as { connected: number }).connected;
}

async function waitForConnected(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await connectedCount()) === expected) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Never reached ${expected} connected signs`);
}

let signA: MockSign;
let signB: MockSign;

beforeAll(async () => {
  signA = await MockSign.connectAuthenticated();
  signB = await MockSign.connectAuthenticated();
});

afterAll(() => {
  signA.close();
  signB.close();
  server.close();
});

test("unauthenticated HTTP requests are rejected", async () => {
  const response = await fetch(`${BASE}/sign/status`);
  expect(response.status).toBe(401);
});

test("two signs coexist under the shared identity", async () => {
  expect(await connectedCount()).toBe(2);
  // Neither connection superseded the other: both still answer pings.
  signA.send({ type: "ping" });
  await signA.next("pong");
  signB.send({ type: "ping" });
  await signB.next("pong");
});

test("wifi reads broadcast to the fleet and the first reply wins", async () => {
  const networks = [{ ssid: "PAL3.0", password: "hunter2", network_type: "personal" }];

  const pendingRead = api("/sign/wifi");
  const requestA = await signA.next("get_wifi");
  const requestB = await signB.next("get_wifi");
  expect(requestB["request_id"]).toBe(requestA["request_id"]);
  signA.send({ type: "wifi_networks", request_id: requestA["request_id"], networks });

  const response = await pendingRead;
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ networks });
});

test("wifi writes reach every sign", async () => {
  const networks = [{ ssid: "PAL3.0", password: "hunter2", network_type: "personal" }];

  const pendingWrite = api("/sign/wifi", { method: "PUT", body: JSON.stringify({ networks }) });
  const requestA = await signA.next("set_wifi");
  const requestB = await signB.next("set_wifi");
  expect(requestA["networks"]).toEqual(networks);
  expect(requestB["networks"]).toEqual(networks);
  signB.send({ type: "wifi_ack", request_id: requestB["request_id"] });
  expect((await pendingWrite).status).toBe(200);
});

test("a syntactically invalid script is rejected by the validator", async () => {
  const response = await api("/sign/script", {
    method: "PUT",
    body: JSON.stringify({ script: "let x = ;" }),
  });
  expect(response.status).toBe(422);
  const body = (await response.json()) as { error: string; line?: number };
  expect(body.line).toBe(1);
});

test("a valid script is stored and broadcast to every sign", async () => {
  const script = "loop { set_all(hsv(280.0, 1.0, 0.5)); sleep(33); }";
  const response = await api("/sign/script", { method: "PUT", body: JSON.stringify({ script }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, connected: 2 });

  const pushA = await signA.next("set_script");
  const pushB = await signB.next("set_script");
  expect(String(pushA["artifact"]).length).toBeGreaterThan(0);
  expect(pushB["artifact"]).toBe(pushA["artifact"]);

  const stored = await api("/sign/script");
  expect(stored.status).toBe(200);
  expect(((await stored.json()) as { script: string }).script).toBe(script);
});

test("a connecting sign gets the stored script replayed", async () => {
  const late = await MockSign.connect();
  late.send({ type: "auth", key: API_KEY });
  const replay = await late.next("set_script");
  expect(String(replay["artifact"]).length).toBeGreaterThan(0);
  late.close();
  await waitForConnected(2);
});

test("deleting the script reverts every sign", async () => {
  const response = await api("/sign/script", { method: "DELETE" });
  expect(response.status).toBe(200);
  await signA.next("clear_script");
  await signB.next("clear_script");
  expect((await api("/sign/script")).status).toBe(404);
});

test("a bad key is refused and the socket closed", async () => {
  const impostor = await MockSign.connect();
  impostor.send({ type: "auth", key: "wrong" });
  const error = await impostor.next("error");
  expect(error["message"]).toBe("Invalid API key");
  const closedBy = await impostor.closed;
  expect(closedBy.code).toBe(1008);
});

test("with zero signs online, wifi 404s but scripts still store", async () => {
  signA.close();
  signB.close();
  await waitForConnected(0);

  const wifi = await api("/sign/wifi");
  expect(wifi.status).toBe(404);
  expect(await wifi.json()).toEqual({ error: "No sign connected" });

  const script = "set_all(255, 0, 255);";
  const push = await api("/sign/script", { method: "PUT", body: JSON.stringify({ script }) });
  expect(push.status).toBe(200);
  expect(await push.json()).toEqual({ ok: true, connected: 0 });

  // A sign connecting later converges to the stored desired state.
  signA = await MockSign.connect();
  signA.send({ type: "auth", key: API_KEY });
  const replay = await signA.next("set_script");
  expect(String(replay["artifact"]).length).toBeGreaterThan(0);
  signB = await MockSign.connectAuthenticated();
});
