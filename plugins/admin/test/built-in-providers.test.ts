import assert from "node:assert/strict";
import test from "node:test";
import { BuiltInProvidersState } from "../ui/settings-built-in-providers.ts";

test("provider keys are write-only, rotation preserves newer input, and disabling sends no secret", async () => {
  const state = new BuiltInProvidersState();
  const calls: unknown[][] = [];
  let pending: ((value: any) => void) | undefined;
  state.actions = {
    api: async (...args) => {
      calls.push(args);
      if (args[0] === "GET")
        return { ok: true, data: { providers: [{ provider: "openai", configured: true, source: "environment" }] } };
      if (args[0] === "PUT")
        return new Promise((resolve) => {
          pending = resolve;
        });
      return { ok: true };
    },
    refresh: async () => {},
  };
  await state.load("org:test");
  const row = state.rows[0]!;
  assert.equal(row.source, "environment");
  assert.equal(row.key, "");
  row.key = "first-key";
  const saving = state.save("openai");
  row.key = "newer-input";
  pending!({ ok: true });
  await saving;
  assert.equal(row.key, "newer-input");
  assert.equal(row.source, "admin");
  await state.save("openai", true);
  assert.equal(row.configured, false);
  assert.deepEqual(calls.at(-1), ["DELETE", "/api/model-providers/openai", undefined]);
});

test("rejected key does not change provider status and personal scopes cannot save", async () => {
  const state = new BuiltInProvidersState();
  let writes = 0;
  state.actions = {
    api: async (method) => {
      if (method === "GET") return { ok: true, data: { providers: [] } };
      writes++;
      return { ok: false, data: { message: "OpenAI rejected this API key" } };
    },
    refresh: async () => {
      throw new Error("must not refresh");
    },
  };
  await state.load("org:test");
  state.rows[0]!.key = "invalid";
  await state.save("openai");
  assert.equal(state.rows[0]!.configured, false);
  assert.equal(state.rows[0]!.error, true);
  await state.load("personal:test");
  await state.save("openai");
  assert.equal(writes, 1);
});

test("shared Codex grants target the selected principal and reload their status", async () => {
  const state = new BuiltInProvidersState();
  const calls: Array<[string, string]> = [];
  let grantees: string[] = [];
  state.actions = {
    api: async (method, path) => {
      calls.push([method, path]);
      if (path === "/api/model-providers?catalog=cached") return { ok: true, data: { providers: [] } };
      if (path === "/api/shared-codex") return { ok: true, data: { connected: true, grantees } };
      if (method === "PUT") grantees = ["user@example.com"];
      if (method === "DELETE") grantees = [];
      return { ok: true };
    },
    refresh: async () => {},
  };
  await state.load("org:test");
  await state.setGrant("USER@EXAMPLE.COM", true);
  assert.deepEqual(calls.find(([method]) => method === "PUT"), ["PUT", "/api/shared-codex/grants/USER%40EXAMPLE.COM"]);
  assert.deepEqual(state.shared.grantees, ["user@example.com"]);
  await state.setGrant("user@example.com", false);
  assert.deepEqual(state.shared.grantees, []);
});
