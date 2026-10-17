import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { sandboxRoutes } from "../src/api/routes/sandboxes.ts";
import type { ApiCtx } from "../src/api/routes/route.ts";

test("unattended capabilities cannot manage sandboxes or delete projects", async (t) => {
  let mutations = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const route = sandboxRoutes.find(
      (route) =>
        "method" in route &&
        route.method === req.method &&
        route.path.includes(url.pathname.includes("projects") ? "projects" : "sandboxes"),
    )!;
    await route.handle({
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method,
      params: url.pathname.includes("projects") ? { id: "owned" } : { scopeId: "personal:alice" },
      body: { action: "retire", sandboxId: "owned", confirm: true },
      capability: { actorId: "alice", liveAuthor: req.headers["x-test-live"] === "true" },
      app: {
        manageSandbox: async () => {
          mutations++;
          return { ok: true };
        },
        deleteProject: async () => {
          mutations++;
          return { lifecycle: "archived" };
        },
        listSandboxes: async () => ({ sandboxes: [] }),
      },
      deps: {},
    } as unknown as ApiCtx);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  for (const [method, path] of [
    ["POST", "/v1/scopes/personal:alice/sandboxes"],
    ["DELETE", "/v1/projects/owned"],
  ]) {
    const denied = await fetch(base + path, { method });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: "live_user_required" });
    assert.equal(mutations, 0);
  }
  const read = await fetch(base + "/v1/scopes/personal:alice/sandboxes");
  assert.equal(read.status, 200);
  const allowed = await fetch(base + "/v1/scopes/personal:alice/sandboxes", {
    method: "POST",
    headers: { "x-test-live": "true" },
  });
  assert.equal(allowed.status, 200);
  assert.equal(mutations, 1);
});
