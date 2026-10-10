import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";
const calls: Array<{ method: string; url: URL; body: Record<string, unknown>; signed: boolean }> = [];
const core = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    calls.push({
      method: req.method!,
      url: new URL(req.url!, "http://core"),
      body: raw ? JSON.parse(raw) : {},
      signed: !!req.headers["x-signature"],
    });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ agents: [] }));
  });
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "agents-web-route-test-secret";
process.env.WEB_UI_PRINCIPALS = "alice";
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
    { p: "alice", exp: Date.now() + 60_000 },
    "agents-web-route-test-secret",
  ),
  "content-type": "application/json",
};
test.after(() => {
  surface.closeAllConnections();
  surface.close();
  core.closeAllConnections();
  core.close();
});
test("agent proxies bind signed-in identity across list, binding, editing and deletion", async () => {
  for (const [method, path] of [
    ["GET", "/api/agents?principalId=mallory&scopeId=personal%3Aalice"],
    ["GET", "/api/agents/binding?threadRef=web%3Aalice%3Achat&principalId=mallory"],
    ["POST", "/api/agents"],
    ["POST", "/api/agents/a"],
    ["POST", "/api/agents/binding"],
    ["DELETE", "/api/agents/a"],
  ]) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(method !== "GET"
        ? { body: JSON.stringify({ principalId: "mallory", action: "save", selection: null }) }
        : {}),
    });
    assert.equal(response.status, 200);
    const call = calls.at(-1)!;
    assert.equal(call.signed, true);
    assert.equal(method === "GET" ? call.url.searchParams.get("principalId") : call.body.principalId, "alice");
    assert.match(call.url.pathname, /^\/v1\/agents/);
  }
  assert.equal((await fetch(`${base}/api/agents`)).status, 401);
});
test("agent package uploads support the core six MB limit", async () => {
  const data = "a".repeat(1_500_000);
  const response = await fetch(`${base}/api/agents/a`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      action: "save",
      package: { files: [{ path: "references/large.pdf", content: data, encoding: "base64" }] },
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(calls.at(-1)!.body).includes(data), true);
});
