import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";

test("MCP admin disable/unblock refreshes the actual Lit view after its container is cleared", async () => {
  const f = litFixture();
  f.document.body.dataset.subview = "mcp";
  const connection = {
    id: "mc1",
    name: "CRM",
    url: "https://tools.example/mcp",
    ownerScopeId: "personal:alice",
    enabled: true,
    blockedByAdmin: false,
  };
  const paths: string[] = [];
  let pending: Promise<void> | undefined;
  const services = {
    api: async (method: string, path: string) => {
      paths.push(path);
      if (method === "POST") {
        connection.enabled = false;
        connection.blockedByAdmin = path.endsWith("/disable");
      }
      return {
        ok: true,
        data: path.endsWith("mcp-policy") ? { policy: { allowInsecurePrivateEndpoints: true } } : { servers: [] },
      };
    },
    refresh: () => {
      f.root.textContent = "";
      pending = f.ui.mcp.mount(f.root, { connections: [{ ...connection }] }, services);
    },
  };
  try {
    await f.ui.mcp.mount(f.root, { connections: [{ ...connection }] }, services);
    const button = () =>
      [...f.root.querySelectorAll<HTMLButtonElement>("button")].find((node) =>
        ["Disable", "Unblock"].includes(node.textContent!.trim()),
      )!;
    assert.equal(button().textContent!.trim(), "Disable");
    button().click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await pending;
    assert.equal(button().textContent!.trim(), "Unblock");
    button().click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await pending;
    assert.equal(button().textContent!.trim(), "Disable");
    assert.ok(paths.includes("/api/mcp-connections/mc1/disable"));
    assert.ok(paths.includes("/api/mcp-connections/mc1/unblock"));
  } finally {
    f.window.close();
  }
});

test("an older MCP admin load cannot overwrite newer inventory", async () => {
  const f = litFixture();
  f.document.body.dataset.subview = "mcp";
  const pending: Array<(value: unknown) => void> = [];
  const services = { api: () => new Promise((resolve) => pending.push(resolve)), refresh: () => {} };
  try {
    const first = f.ui.mcp.mount(
      f.root,
      { connections: [{ id: "old", name: "Old", url: "https://old.example/mcp" }] },
      services,
    );
    const second = f.ui.mcp.mount(
      f.root,
      { connections: [{ id: "new", name: "New", url: "https://new.example/mcp" }] },
      services,
    );
    pending[2]!({ ok: true, data: { servers: [] } });
    pending[3]!({ ok: true, data: { policy: { allowInsecurePrivateEndpoints: true } } });
    await second;
    pending[0]!({ ok: true, data: { servers: [] } });
    pending[1]!({ ok: true, data: { policy: { allowInsecurePrivateEndpoints: true } } });
    await first;
    assert.match(f.root.textContent!, /New/);
    assert.doesNotMatch(f.root.textContent!, /Old/);
  } finally {
    f.window.close();
  }
});

test("MCP endpoint toggle saves immediately and retains persisted state when saving fails", async () => {
  const f = litFixture();
  f.document.body.dataset.subview = "mcp";
  let enabled = true;
  let fail = false;
  let pending: Promise<void> | undefined;
  const writes: unknown[] = [];
  const services = {
    api: async (method: string, path: string, body?: unknown) => {
      if (method === "PUT") {
        writes.push(body);
        if (fail) return { ok: false, data: { message: "Save failed" } };
        enabled = (body as { allowInsecurePrivateEndpoints: boolean }).allowInsecurePrivateEndpoints;
      }
      return {
        ok: true,
        data: path.endsWith("mcp-policy") ? { policy: { allowInsecurePrivateEndpoints: enabled } } : { servers: [] },
      };
    },
    refresh: () => {
      f.root.textContent = "";
      pending = f.ui.mcp.mount(f.root, { connections: [] }, services);
    },
  };
  try {
    await f.ui.mcp.mount(f.root, { connections: [] }, services);
    const toggle = () => f.root.querySelector<HTMLInputElement>('[role="switch"]')!;
    assert.equal(toggle().checked, true);
    assert.doesNotMatch(f.root.textContent!, /Add exception|Addresses or CIDRs/);
    toggle().click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await pending;
    assert.equal(toggle().checked, false);
    assert.deepEqual(JSON.parse(JSON.stringify(writes)), [{ allowInsecurePrivateEndpoints: false }]);
    fail = true;
    toggle().click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(toggle().checked, false);
    assert.match(f.root.textContent!, /Save failed/);
    fail = false;
    toggle().click();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await pending;
    assert.equal(toggle().checked, true);
  } finally {
    f.window.close();
  }
});
