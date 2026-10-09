import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createProjectStore, projectScopeId } from "../src/projects/project-store.ts";
import { createMcpConnectionService, McpAccessError } from "../src/mcp/mcp-connection-service.ts";
import type { McpConnection, McpAccount, McpOAuthFlow } from "../src/mcp/mcp-connection-store.ts";
import { deriveConnectorKey } from "../src/connectors/connector-client-store.ts";
import {
  createMcpEndpointPolicy,
  isPublicMcpAddress,
  validateMcpPolicy,
  type McpEndpointPolicy,
} from "../src/mcp/mcp-endpoint-policy.ts";
import type { McpExecutionContext } from "../src/mcp/mcp-connection-service.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { parseRef } from "../src/acl/resource-ref.ts";

function fixture(encryption = true) {
  const stores = {
    connections: createMemoryMap<McpConnection>(),
    accounts: createMemoryMap<McpAccount>(),
    flows: createMemoryMap<McpOAuthFlow>(),
  };
  const projects = createProjectStore(undefined, { isActiveMember: () => true });
  const acl = createAclStore();
  const active = new Set(["alice", "bob", "carol"]);
  const calls: Array<{ method: string; token: string; tool?: string }> = [];
  const events: unknown[] = [];
  const policy = {
    read: async () => ({ exceptions: [] }),
    write: async (input: unknown) => validateMcpPolicy(input),
    validate: async (input: string | URL) => ({ url: new URL(input), addresses: [{ address: "8.8.8.8", family: 4 }] }),
    fetch: (async (_url, init) => {
      const url = new URL(String(_url));
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
        return Response.json({
          resource: "https://tools.example/mcp",
          authorization_servers: ["https://auth.example"],
        });
      if (
        url.pathname.startsWith("/.well-known/oauth-authorization-server") ||
        url.pathname.startsWith("/.well-known/openid-configuration")
      )
        return Response.json({
          issuer: "https://auth.example",
          authorization_endpoint: "https://auth.example/authorize",
          token_endpoint: "https://auth.example/token",
          registration_endpoint: "https://auth.example/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
        });
      if (url.pathname === "/register")
        return Response.json({ ...JSON.parse(String(init?.body)), client_id: "qm-client" }, { status: 201 });
      if (url.hostname === "auth.example" && url.pathname === "/token") {
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get("resource"), "https://tools.example/mcp");
        if (body.get("grant_type") === "authorization_code") assert.ok(body.get("code_verifier"));
        return Response.json({
          access_token: "oauth-access",
          token_type: "Bearer",
          refresh_token: "oauth-refresh",
          expires_in: 1,
        });
      }
      const headers = new Headers(init?.headers);
      const token = headers.get("authorization") ?? "";
      if (init?.method === "GET") return new Response(null, { status: 405 });
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const request = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string } };
      if (request.id === undefined) return new Response(null, { status: 202 });
      calls.push({ method: request.method, token, tool: request.params?.name });
      let result: unknown = { content: [{ type: "text", text: token || "public" }] };
      if (request.method === "initialize")
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        };
      if (request.method === "tools/list")
        result = {
          tools: [
            {
              name: "query",
              description: token.includes("bob") ? "Bob catalog" : "Alice catalog",
              inputSchema: { type: "object" },
            },
            { name: "update", inputSchema: { type: "object" } },
          ],
        };
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    }) as typeof fetch,
  };
  const service = createMcpConnectionService({
    stores,
    projects,
    acl,
    policy,
    ...(encryption ? { key: deriveConnectorKey("test-secret") } : {}),
    lock: createMemoryAdvisoryLock(),
    audit: createAuditLog(),
    active: async (id) => active.has(id),
    callbackUrl: "https://qm.example/api/mcp-oauth/callback",
  });
  const context = (actor: string, scope = `personal:${actor}`, unattended = false): McpExecutionContext => ({
    principalId: actor,
    scopeId: scope,
    unattended,
    audience: [{ id: actor, type: "internal" }],
  });
  async function connected(home?: string) {
    const row = await service.create("alice", {
      name: "CRM",
      url: "https://tools.example/mcp",
      auth: "bearer",
      ownerScopeId: home,
    });
    await service.connect(row.id, "alice", { bearerToken: "alice-secret" });
    await service.test(row.id, "alice");
    await service.update(row.id, "alice", {
      enabled: true,
      tools: [
        { name: "query", approved: true, readOnly: true },
        { name: "update", approved: true, readOnly: false },
      ],
    });
    return row.id;
  }
  return { stores, projects, acl, active, calls, events, service, context, connected };
}

test("MCP refs participate in ACL sharing", () =>
  assert.deepEqual(parseRef("mcp:connection"), { kind: "mcp", id: "connection" }));

test("personal connections and encrypted credentials are isolated", async () => {
  const f = fixture();
  const id = await f.connected();
  assert.equal((await f.service.list("bob")).length, 0);
  await assert.rejects(f.service.get(id, "bob"), McpAccessError);
  assert.equal(JSON.stringify(await f.stores.accounts.all()).includes("alice-secret"), false);
  assert.equal(JSON.stringify(await f.stores.connections.all()).includes("alice-secret"), false);
  const turn = await f.service.forTurn(f.context("alice"));
  assert.equal(turn.toolDefs().length, 2);
  assert.equal(turn.toolDefs().length, 2);
  assert.equal(await turn.call(`${id}_query`, {}), "Bearer alice-secret");
});

test("own-account shares require the recipient's account and isolate discovery", async () => {
  const f = fixture();
  const id = await f.connected();
  await f.service.share(id, "alice", {
    scopeId: "personal:bob",
    tools: ["query"],
    write: false,
    unattended: false,
    account: "own",
  });
  const listed = await f.service.get(id, "bob");
  assert.equal(listed.tools.length, 0);
  assert.equal((await f.service.forTurn(f.context("bob"))).toolDefs().length, 0);
  await f.service.connect(id, "bob", { bearerToken: "bob-secret" });
  await f.service.test(id, "bob");
  const turn = await f.service.forTurn(f.context("bob"));
  assert.equal(turn.toolDefs().length, 1);
  assert.equal(await turn.call(`${id}_query`, {}), "Bearer bob-secret");
  await assert.rejects(turn.call(`${id}_update`, {}), McpAccessError);
  await assert.rejects(f.service.update(id, "bob", { enabled: false }), McpAccessError);
  await assert.rejects(
    f.service.share(id, "bob", {
      scopeId: "personal:carol",
      tools: ["query"],
      write: false,
      unattended: false,
      account: "saved",
    }),
    McpAccessError,
  );
});

test("saved-account shares use the credential owner and revoke stale tools immediately", async () => {
  const f = fixture();
  const id = await f.connected();
  await f.service.share(id, "alice", {
    scopeId: "personal:bob",
    tools: ["query"],
    write: false,
    unattended: false,
    account: "saved",
    accountOwner: "carol",
  });
  const turn = await f.service.forTurn(f.context("bob"));
  assert.equal(await turn.call(`${id}_query`, {}), "Bearer alice-secret");
  await f.service.revoke(id, "alice", "personal:bob");
  await assert.rejects(turn.call(`${id}_query`, {}), McpAccessError);
  assert.equal((await f.service.list("bob")).length, 0);
});

test("project sharing is limited to the project and follows current membership", async () => {
  const f = fixture();
  const project = await f.projects.create({ name: "Support", ownerId: "alice" });
  await f.projects.addMember(project.id, "alice", "bob");
  const scope = projectScopeId(project.id);
  const id = await f.connected();
  await f.service.share(id, "alice", {
    scopeId: scope,
    tools: ["query"],
    write: false,
    unattended: false,
    account: "saved",
  });
  assert.equal((await f.service.list("bob")).length, 1);
  assert.equal((await f.service.forTurn(f.context("bob"))).toolDefs().length, 0);
  const context = {
    ...f.context("bob", scope),
    audience: [
      { id: "bob", type: "internal" as const },
      { id: "alice", type: "internal" as const },
    ],
  };
  const turn = await f.service.forTurn(context);
  assert.equal(await turn.call(`${id}_query`, {}), "Bearer alice-secret");
  await f.projects.removeMember(project.id, "alice", "bob");
  await assert.rejects(turn.call(`${id}_query`, {}), McpAccessError);
});

test("private personal access does not leak into shared conversations", async () => {
  const f = fixture();
  await f.connected();
  const shared = {
    ...f.context("alice"),
    audience: [
      { id: "alice", type: "internal" as const },
      { id: "bob", type: "internal" as const },
    ],
  };
  assert.equal((await f.service.forTurn(shared)).toolDefs().length, 0);
});

test("read-only, unattended, disconnect, configuration changes and disablement are enforced at call time", async () => {
  const f = fixture();
  const id = await f.connected();
  assert.equal((await f.service.forTurn({ ...f.context("alice"), readOnly: true })).toolDefs().length, 1);
  assert.equal((await f.service.forTurn(f.context("alice", "personal:alice", true))).toolDefs().length, 0);
  const turn = await f.service.forTurn(f.context("alice"));
  await f.service.disable(id, "alice");
  await assert.rejects(turn.call(`${id}_query`, {}), McpAccessError);
  await assert.rejects(f.service.update(id, "alice", { enabled: true }), McpAccessError);
  await f.service.unblock(id, "alice");
  await f.service.update(id, "alice", { enabled: true });
  await f.service.disconnect(id, "alice");
  await assert.rejects(turn.call(`${id}_query`, {}), McpAccessError);
  await f.service.connect(id, "alice", { bearerToken: "replacement" });
  await f.service.test(id, "alice");
  await f.service.update(id, "alice", { url: "https://other.example/mcp" });
  await assert.rejects(turn.call(`${id}_query`, {}), McpAccessError);
});

test("project owners alone manage project connections; saved home credentials require their owner's authorization", async () => {
  const f = fixture();
  const project = await f.projects.create({ name: "Support", ownerId: "alice" });
  await f.projects.addMember(project.id, "alice", "bob");
  const scope = projectScopeId(project.id);
  await assert.rejects(
    f.service.create("bob", { name: "No", url: "https://tools.example/mcp", auth: "none", ownerScopeId: scope }),
    McpAccessError,
  );
  const id = await f.connected(scope);
  await assert.rejects(f.service.update(id, "alice", { homeAccountOwner: "bob" }), McpAccessError);
  await f.service.update(id, "alice", { homeAccountOwner: "alice" });
  assert.equal(await (await f.service.forTurn(f.context("bob", scope))).call(`${id}_query`, {}), "Bearer alice-secret");
});

test("network policy blocks private and mapped addresses and validates explicit exceptions", async () => {
  for (const address of [
    "127.0.0.1",
    "10.2.3.4",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "198.18.1.1",
  ])
    assert.equal(isPublicMcpAddress(address), false, address);
  assert.equal(isPublicMcpAddress("8.8.8.8"), true);
  const policy = createMcpEndpointPolicy(createMemoryMap<McpEndpointPolicy>());
  await assert.rejects(policy.validate("https://127.0.0.1/mcp"));
  await policy.write({ exceptions: [{ hostname: "127.0.0.1", port: 8080, addresses: ["127.0.0.1/32"] }] });
  await policy.validate("http://127.0.0.1:8080/mcp");
  await assert.rejects(policy.validate("http://127.0.0.1:8081/mcp"));
  await assert.rejects(
    policy.write({ exceptions: [{ hostname: "localhost", port: 80, addresses: ["127.0.0.1/99"] }] }),
  );
});

test("OAuth discovery, PKCE callback, refresh and replay protection are durable and encrypted", async () => {
  const f = fixture();
  const row = await f.service.create("alice", { name: "OAuth", url: "https://tools.example/mcp", auth: "oauth" });
  const started = await f.service.connect(row.id, "alice", {});
  assert.ok("authorizationUrl" in started);
  const url = new URL(started.authorizationUrl!);
  assert.equal(url.origin, "https://auth.example");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), "https://tools.example/mcp");
  const state = url.searchParams.get("state")!;
  const flow = await f.stores.flows.get(state);
  assert.ok(flow?.secretEnc.startsWith("v2:"));
  assert.equal(await f.service.callback(state, "auth-code"), row.id);
  await assert.rejects(f.service.callback(state, "auth-code"));
  await f.service.test(row.id, "alice");
  assert.equal(f.calls.find((call) => call.method === "tools/list")?.token, "Bearer oauth-access");
  assert.equal(JSON.stringify(await f.stores.accounts.all()).includes("oauth-refresh"), false);
});

test("disconnect removes saved-account delegation and reconnection does not restore it", async () => {
  const f = fixture();
  const id = await f.connected();
  await f.service.share(id, "alice", {
    scopeId: "personal:bob",
    tools: ["query"],
    write: false,
    unattended: false,
    account: "saved",
  });
  const turn = await f.service.forTurn(f.context("bob"));
  await f.service.disconnect(id, "alice");
  await f.service.connect(id, "alice", { bearerToken: "different-account" });
  await f.service.test(id, "alice");
  await assert.rejects(turn.call(`${id}_query`, {}), McpAccessError);
});

test("legacy credentials migrate once into encryption while runtime reads stay compatible", async () => {
  const { createMcpServerStore } = await import("../src/mcp/mcp-server-store.ts");
  const backing = createMemoryMap<import("../src/mcp/mcp-server-store.ts").McpServer>();
  await backing.put("legacy", {
    id: "legacy",
    name: "Legacy",
    url: "https://tools.example/mcp",
    auth: "bearer",
    bearerToken: "legacy-token",
    readOnly: true,
    enabled: true,
    updatedAt: 1,
    updatedBy: "alice",
  });
  const store = createMcpServerStore(backing, deriveConnectorKey("migration-key"));
  assert.equal((await store.get("legacy"))?.bearerToken, "legacy-token");
  const encrypted = await backing.get("legacy");
  assert.ok(encrypted?.secretEnc);
  assert.equal(JSON.stringify(encrypted).includes("legacy-token"), false);
  await store.list();
  assert.equal((await backing.get("legacy"))?.secretEnc, encrypted.secretEnc);
});

test("guarded HTTP fetch pins approved endpoints, streams SSE and rejects redirects", async (t) => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://127.0.0.1/secret" });
      res.end();
      return;
    }
    res.setHeader("content-type", "text/event-stream");
    res.write("data: first\n\n");
    setTimeout(() => res.end("data: second\n\n"), 25);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const port = (server.address() as { port: number }).port;
  const policy = createMcpEndpointPolicy(createMemoryMap<McpEndpointPolicy>());
  await policy.write({ exceptions: [{ hostname: "localhost", port, addresses: ["127.0.0.2/32"] }] });
  await assert.rejects(policy.validate(`http://localhost:${port}/mcp`));
  await policy.write({ exceptions: [{ hostname: "127.0.0.1", port, addresses: ["127.0.0.1/32"] }] });
  const response = await policy.fetch(`http://127.0.0.1:${port}/mcp`);
  assert.match(await response.text(), /data: first[\s\S]*data: second/);
  await assert.rejects(policy.fetch(`http://127.0.0.1:${port}/redirect`));
});

test("public no-auth connections work without credential encryption", async () => {
  const f = fixture(false);
  const row = await f.service.create("alice", { name: "Public", url: "https://tools.example/mcp", auth: "none" });
  await f.service.test(row.id, "alice");
  await f.service.update(row.id, "alice", {
    enabled: true,
    tools: [{ name: "query", approved: true, readOnly: true }],
  });
  assert.equal(await (await f.service.forTurn(f.context("alice"))).call(`${row.id}_query`, {}), "public");
});

test("account replacement clears saved-account delegation and failed updates do not mutate memory storage", async () => {
  const f = fixture();
  const id = await f.connected();
  await f.service.share(id, "alice", {
    scopeId: "personal:bob",
    tools: ["query"],
    write: false,
    unattended: false,
    account: "saved",
  });
  const stale = await f.service.forTurn(f.context("bob"));
  await f.service.connect(id, "alice", { bearerToken: "new-account" });
  await f.service.test(id, "alice");
  await assert.rejects(stale.call(`${id}_query`, {}), McpAccessError);
  await assert.rejects(
    f.service.update(id, "alice", {
      name: "Must not persist",
      tools: [{ name: "absent", approved: true, readOnly: false }],
    }),
  );
  assert.equal((await f.service.get(id, "alice")).name, "CRM");
});

test("credential owners can disconnect their own account after connection access is revoked", async () => {
  const f = fixture();
  const id = await f.connected();
  await f.service.share(id, "alice", {
    scopeId: "personal:bob",
    tools: ["query"],
    write: false,
    unattended: false,
    account: "own",
  });
  await f.service.connect(id, "bob", { bearerToken: "bob-token" });
  await f.service.revoke(id, "alice", "personal:bob");
  await assert.rejects(f.service.get(id, "bob"), McpAccessError);
  await f.service.disconnect(id, "bob");
  assert.equal(await f.stores.accounts.get(`${id}:bob`), null);
  assert.ok(await f.stores.accounts.get(`${id}:alice`));
});
