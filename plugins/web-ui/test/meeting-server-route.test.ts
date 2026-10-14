import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

const calls: Call[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const path = new URL(req.url ?? "/", "http://core").pathname;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (!path.startsWith("/v1/surface-config")) calls.push({ method: req.method ?? "GET", path, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(path === "/v1/turns" ? { status: "silent" } : { meeting: { sessionId: "s1" } }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "meeting-web-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = { cookie: "webuiuser=alice", "content-type": "application/json" };

test.after(() => {
  surface.close();
  core.close();
});

async function relayed(method: string, path: string, body: Record<string, unknown>): Promise<Call> {
  const before = calls.length;
  const response = await fetch(`${base}${path}`, { method, headers, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  return calls[before]!;
}

test("starting a meeting pins the signed-in member and passes the chosen settings", async () => {
  const call = await relayed("POST", "/api/projects/p1/meetings", {
    principalId: "mallory",
    title: "  Pricing review  ",
    mode: "judged",
    prompt: "Stay brief.",
  });
  assert.equal(call.method, "POST");
  assert.equal(call.path, "/v1/projects/p1/meetings");
  assert.deepEqual(call.body, { principalId: "alice", title: "Pricing review", mode: "judged", prompt: "Stay brief." });
});

test("changing settings and ending relay only what the member sent", async () => {
  const patch = await relayed("PATCH", "/api/meetings/s1", { mode: "off" });
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.path, "/v1/meetings/s1");
  assert.deepEqual(patch.body, { principalId: "alice", mode: "off" });

  const end = await relayed("POST", "/api/meetings/s1/end", { outputs: ["minutes", "tasks"] });
  assert.equal(end.path, "/v1/meetings/s1/end");
  assert.deepEqual(end.body, { principalId: "alice", outputs: ["minutes", "tasks"] });
});

test("a turn carries the mention flag only when the composer set it", async () => {
  const turn = (extra: Record<string, unknown>) =>
    relayed("POST", "/api/turn", {
      text: "ship friday",
      threadRef: "web:bob:meeting",
      scopeId: "group:web-project-p1",
      ...extra,
    });
  assert.equal((await turn({ mentionsAssistant: true })).body.mentionsAssistant, true);
  assert.equal("mentionsAssistant" in (await turn({})).body, false);
  assert.equal("mentionsAssistant" in (await turn({ mentionsAssistant: "yes" })).body, false);
});
