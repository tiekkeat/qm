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
