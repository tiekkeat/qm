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
      let result: unknown = {
        tools: Array.from({ length: 85 }, (_, index) => ({
          name: index === 0 ? "query" : `opnsense_${index}`,
          inputSchema: { type: "object" },
        })),
      };
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
    adminGrants: "alice:org_admin",
  });
  const built = buildApp(config);
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
    method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
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
  const names = Array.from({ length: 85 }, (_, index) => (index === 0 ? "query" : `opnsense_${index}`));
  assert.equal(
    (
      await request("PATCH", `/v1/mcp-connections/${id}?principalId=alice`, {
        tools: names.map((name) => ({ name, approved: true, readOnly: true })),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("POST", `/v1/mcp-connections/${id}/shares?principalId=alice`, {
        scopeId: "personal:bob",
        tools: [...names, names[0]],
        write: false,
        unattended: false,
        account: "own",
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("PATCH", `/v1/mcp-connections/${id}?principalId=bob`, { name: "Not allowed" }, bob)).status,
    404,
  );
  assert.equal((await request("DELETE", `/v1/mcp-connections/${id}?principalId=bob`, {}, bob)).status, 404);
  const policyPath = "/v1/admin/mcp-policy";
  assert.equal((await request("GET", policyPath, {}, bob)).status, 403);
  assert.equal((await request("PUT", policyPath, { allowInsecurePrivateEndpoints: false }, bob)).status, 403);
  assert.deepEqual(JSON.parse((await request("GET", policyPath)).text).policy, { allowInsecurePrivateEndpoints: true });
  assert.equal((await request("PUT", policyPath, { allowInsecurePrivateEndpoints: "false" })).status, 400);
  assert.equal((await request("PUT", policyPath, { allowInsecurePrivateEndpoints: false })).status, 200);
  const blocked = await request("POST", `/v1/mcp-connections/${id}/test?principalId=alice`);
  assert.equal(blocked.status, 400);
  assert.match(JSON.parse(blocked.text).message, /HTTP MCP endpoints are disabled/);
  assert.equal((await request("POST", "/v1/mcp-connections?principalId=alice", input)).status, 400);
  assert.equal((await request("PUT", policyPath, { allowInsecurePrivateEndpoints: true })).status, 200);
  assert.equal((await request("POST", `/v1/mcp-connections/${id}/test?principalId=alice`)).status, 200);
  assert.deepEqual(
    (await built.auditLog.events())
      .filter((event) => event.action === "mcp.policy.update")
      .map((event) => JSON.parse(event.detail!)),
    [{ allowInsecurePrivateEndpoints: false }, { allowInsecurePrivateEndpoints: true }],
  );
});
