import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const calls: Array<{ method: string; url: URL; body: Record<string, unknown>; signed: boolean }> = [];
const core = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    const url = new URL(req.url!, "http://core");
    calls.push({ method: req.method!, url, body: raw ? JSON.parse(raw) : {}, signed: !!req.headers["x-signature"] });
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify(
        url.pathname === "/v1/mcp-oauth/callback"
          ? { connected: true, connectionId: "mc1" }
          : { connections: [], projects: [], legacy: [] },
      ),
    );
  });
});
await new Promise<void>((resolve) => core.listen(0, "127.0.0.1", resolve));
process.env.CORE_API_URL = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "mcp-surface-route-test-secret";
process.env.WEB_UI_PRINCIPALS = "alice";
const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity(
    { p: "alice", exp: Date.now() + 60_000 },
    "mcp-surface-route-test-secret",
  ),
  "content-type": "application/json",
};
test.after(() => {
  surface.closeAllConnections();
  surface.close();
  core.closeAllConnections();
  core.close();
});

test("MCP proxy binds all methods to the signed-in user and signs core requests", async () => {
  for (const [method, path] of [
    ["GET", "/api/mcp-connections"],
    ["POST", "/api/mcp-connections"],
    ["PATCH", "/api/mcp-connections/mc1"],
    ["POST", "/api/mcp-connections/mc1/account"],
    ["POST", "/api/mcp-connections/mc1/shares"],
    ["DELETE", "/api/mcp-connections/mc1/shares?scopeId=personal%3Abob"],
  ]) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(method === "POST" || method === "PATCH"
        ? { body: JSON.stringify({ principalId: "mallory", name: "Tools" }) }
        : {}),
    });
    assert.equal(response.status, 200);
    const call = calls.findLast(
      (call) => call.method === method && call.url.pathname.startsWith("/v1/mcp-connections"),
    )!;
    assert.equal(call.url.searchParams.get("principalId"), "alice");
    assert.equal(call.signed, true);
    if (method === "POST" || method === "PATCH") assert.equal(call.body.principalId, "alice");
    if (method === "DELETE") assert.equal(call.url.searchParams.get("scopeId"), "personal:bob");
  }
});

test("MCP endpoints require sign-in while the single-use OAuth callback remains reachable", async () => {
  assert.equal((await fetch(`${base}/api/mcp-connections`)).status, 401);
  const response = await fetch(`${base}/api/mcp-oauth/callback?state=opaque&code=code`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /view=mcp/);
  assert.equal(calls.at(-1)?.url.pathname, "/v1/mcp-oauth/callback");
});
