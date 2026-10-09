import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer as httpServer } from "node:http";
import { once } from "node:events";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { createServer } from "../src/api/server.ts";
import { fetchCoreText } from "../plugins/chassis/src/core-client.ts";
import { mintPortalIdentity } from "../src/auth/portal-identity.ts";

const signingSecret = "mcp-api-ingress-secret-at-least-32-characters";
const portalSecret = "mcp-api-portal-secret-at-least-32-characters";

test("MCP core API requires portal identity, prevents impersonation, and returns redacted scoped records", async (t) => {
  const remote = httpServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = JSON.parse(raw);
      if (body.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      let result: unknown = { tools: [{ name: "query", inputSchema: { type: "object" } }] };
      if (body.method === "initialize")
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "CRM", version: "1" },
        };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  remote.listen(0, "127.0.0.1");
  await once(remote, "listening");
  const port = (remote.address() as { port: number }).port;
  const config = testConfig({
    signingSecret,
    portalIdentitySecret: portalSecret,
    emailAuthPrincipals: ["alice", "bob"],
  });
  const built = buildApp(config);
  await built.mcpConnections.policy.write({
    exceptions: [{ hostname: "127.0.0.1", port, addresses: ["127.0.0.1/32"] }],
  });
  const core = createServer(built.app, { ...serverDeps(config, built), requireSignedPortalIdentity: true });
  core.listen(0, "127.0.0.1");
  await once(core, "listening");
  t.after(() => {
    built.mcpToolService.close();
    core.closeAllConnections();
    core.close();
    remote.closeAllConnections();
    remote.close();
  });
  const origin = `http://127.0.0.1:${(core.address() as { port: number }).port}`;
  const identity = await mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, portalSecret);
  const request = (
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body = {},
    signedIdentity: string | null = identity,
  ) =>
    fetchCoreText({
      origin,
      secret: signingSecret,
      method,
      path,
      body: method === "GET" || method === "DELETE" ? "" : JSON.stringify(body),
      headers: signedIdentity ? { "x-portal-identity": signedIdentity } : {},
    });
  assert.equal((await request("GET", "/v1/mcp-connections?principalId=alice", {}, null)).status, 401);
  assert.equal((await request("GET", "/v1/mcp-connections?principalId=bob")).status, 403);
  const input = { name: "CRM", url: `http://127.0.0.1:${port}/mcp`, auth: "bearer", principalId: "alice" };
  assert.equal(
    (await request("POST", "/v1/mcp-connections?principalId=alice", { ...input, principalId: "bob" })).status,
    404,
  );
  const created = await request("POST", "/v1/mcp-connections?principalId=alice", input);
  assert.equal(created.status, 201);
  const id = JSON.parse(created.text).connection.id;
  await assert.rejects(
    built.app.grant({
      ownerScopeId: "personal:alice",
      ref: `mcp:${id}`,
      granteeScopeId: "personal:bob",
      permission: "read",
      grantedBy: "alice",
    }),
    /MCP sharing API/,
  );
  await assert.rejects(
    built.app.revokeGrant("personal:alice", `mcp:${id}`, "personal:bob", "alice"),
    /MCP sharing API/,
  );
  assert.equal(
    (
      await request("POST", `/v1/mcp-connections/${id}/account?principalId=alice`, {
        principalId: "alice",
        bearerToken: "secret-account-token",
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("POST", `/v1/mcp-connections/${id}/test?principalId=alice`, { principalId: "alice" })).status,
    200,
  );
  const listed = await request("GET", "/v1/mcp-connections?principalId=alice");
  assert.doesNotMatch(listed.text, /secret-account-token|secretEnc|clientSecret/);
  assert.equal(JSON.parse(listed.text).connections.length, 1);
  const bob = await mintPortalIdentity({ p: "bob", exp: Date.now() + 60_000 }, portalSecret);
  assert.equal(
    JSON.parse((await request("GET", "/v1/mcp-connections?principalId=bob", {}, bob)).text).connections.length,
    0,
  );
  assert.equal((await request("GET", `/v1/mcp-connections/${id}?principalId=bob`, {}, bob)).status, 404);
});
