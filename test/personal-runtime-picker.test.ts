import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";
import type { userRuntimeConfigBody } from "../src/api/runtime-config.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { signedHeaders, withSourceAuthNonce } from "../plugins/chassis/src/core-client.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import { createRuntimeService } from "../src/harness/runtime-control.ts";

type Snapshot = Awaited<ReturnType<typeof userRuntimeConfigBody>>;

async function setup() {
  const built = buildApp(testConfig());
  built.config.setApprovedHarnesses(["pi", "claude", "codex"]);
  await built.config.flushScope("org:default-org");
  const signingSecret = "personal-runtime-source-auth-secret-0001";
  const identitySecret = "personal-runtime-portal-identity-secret-0001";
  const server = createServer(built.app, {
    signingSecret,
    capabilitySecret: "personal-runtime-capability-secret-0001",
    portalIdentitySecret: identitySecret,
    requireSignedPortalIdentity: true,
    identity: built.identity,
    config: built.config,
    userModelCredentials: built.userModelCredentials,
    harnessId: "pi",
    providerKeys: { anthropic: false, openai: false, openrouter: false },
  });
  server.listen(0);
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const request = async (method: "GET" | "PUT", path: string, user: string, value?: unknown) => {
    path = withSourceAuthNonce(path, signingSecret);
    const body = value === undefined ? "" : JSON.stringify(value);
    return fetch(base + path, {
      method,
      headers: {
        ...signedHeaders(signingSecret, method, path, body),
        [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: user, exp: Date.now() + 60_000 }, identitySecret),
      },
      ...(value === undefined ? {} : { body }),
    });
  };
  const get = async (user = "U1", scope = `personal:${user}`) => {
    const response = await request(
      "GET",
      `/v1/runtime-config?principalId=${user}&scopeId=${encodeURIComponent(scope)}`,
      user,
    );
    assert.equal(response.status, 200);
    return response.json() as Promise<Snapshot>;
  };
  const put = (choice: object) =>
    request("PUT", "/v1/runtime-config", "U1", { principalId: "U1", scopeId: "personal:U1", ...choice });
  return {
    built,
    get,
    put,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      await built.runtime.stop();
    },
  };
}

test("personal API-key picker works without company keys and saves model, effort and Fast", async () => {
  const s = await setup();
  try {
    await s.built.userModelCredentials.setApiKey("U1", "openai", "synthetic-openai");
    await s.built.config.setPersonalModelAuth("U1", true, "openai");
    const before = await s.get();
    assert.ok(before.modelsByHarness.pi!.includes("gpt-5.6-terra"));
    assert.ok(before.modelsByHarness.pi!.every((id: string) => resolveModel(id)?.provider === "openai"));
    assert.deepEqual(before.modelsByHarness.claude, []);
    assert.deepEqual(before.modelsByHarness.codex, []);
    assert.ok(before.modelsByHarness.pi!.includes(before.effective.modelId));
    assert.equal(before.unavailableReason, undefined);
    assert.doesNotMatch(JSON.stringify(before), /synthetic-openai/);
    const choice = { harnessId: "pi", modelId: "gpt-5.6-terra", effortLevel: "high", fastMode: true };
    const saved = await s.put(choice);
    assert.equal(saved.status, 200);
    assert.deepEqual(((await saved.json()) as Snapshot).effective, choice);
    assert.deepEqual((await s.get()).effective, choice);
    assert.equal((await s.put({ ...choice, modelId: "claude-sonnet-5" })).status, 400);
    await s.built.userModelCredentials.delete("U1", "openai");
    assert.deepEqual((await s.get()).modelsByHarness.pi, []);
    assert.equal((await s.put(choice)).status, 400);
  } finally {
    await s.close();
  }
});

for (const provider of ["anthropic", "openai"] as const) {
  test(`personal ${provider} OAuth picker advertises only compatible runtimes`, async () => {
    const s = await setup();
    try {
      await s.built.userModelCredentials.setOAuth("U1", provider, {
        accessToken: "synthetic-access",
        refreshToken: "synthetic-refresh",
        expiresAt: Date.now() + 3_600_000,
      });
      await s.built.config.setPersonalModelAuth("U1", true, provider);
      const config = await s.get();
      if (provider === "anthropic") {
        assert.deepEqual(config.modelsByHarness.pi, []);
        assert.ok(config.modelsByHarness.claude!.includes("claude-sonnet-5"));
        assert.deepEqual(config.modelsByHarness.codex, []);
      } else {
        assert.ok(config.modelsByHarness.pi!.includes("codex/gpt-5.6-sol"));
        assert.ok(!config.modelsByHarness.pi!.includes("gpt-5.6-sol"));
        assert.ok(config.modelsByHarness.codex!.includes("gpt-5.6-sol"));
        assert.deepEqual(config.modelsByHarness.claude, []);
      }
      assert.ok(config.modelsByHarness[config.effective.harnessId]!.includes(config.effective.modelId));
    } finally {
      await s.close();
    }
  });
}

test("personal picker keeps org restrictions and shared-scope caller isolation", async () => {
  const s = await setup();
  try {
    await s.built.userModelCredentials.setApiKey("U1", "openai", "synthetic-openai");
    await s.built.userModelCredentials.setApiKey("U2", "anthropic", "synthetic-anthropic");
    await s.built.config.setPersonalModelAuth("U1", true, "openai");
    await s.built.config.setPersonalModelAuth("U2", true, "anthropic");
    await s.built.directory.replaceGroups([
      { groupId: "room", principalId: "U1" },
      { groupId: "room", principalId: "U2" },
    ]);
    assert.ok((await s.get("U1", "group:room")).modelsByHarness.pi!.includes("gpt-5.6-terra"));
    assert.ok(!(await s.get("U2", "group:room")).modelsByHarness.pi!.includes("gpt-5.6-terra"));
    await s.built.config.setRuntimeSelectionLatest("personal:U1", { harnessId: "pi", modelId: "gpt-5.6-terra" });
    s.built.config.setWebuiModels("org:default-org", ["gpt-5.6-sol"]);
    await s.built.config.flushScope("org:default-org");
    assert.ok(!(await s.get()).modelsByHarness.pi!.includes("gpt-5.6-terra"));
    assert.equal((await s.put({ harnessId: "pi", modelId: "gpt-5.6-terra" })).status, 400);
    const refused = await s.built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "web:U1:excluded-saved-model" },
      text: "hello",
      liveActor: true,
      async: true,
      harness: "pi",
      model: "gpt-5.6-terra",
    });
    assert.equal(refused.status, "refused");
    s.built.config.setWebuiModels("org:default-org", []);
    await s.built.config.flushScope("org:default-org");
    assert.ok((await s.get()).modelsByHarness.pi!.includes("gpt-5.6-terra"));
  } finally {
    await s.close();
  }
});

for (const provider of ["anthropic", "openai"] as const) {
  test(`personal ${provider} subscription ignores organization model and harness restrictions`, async () => {
    const s = await setup();
    try {
      s.built.config.setApprovedHarnesses([]);
      s.built.config.setWebuiModels("org:default-org", [provider === "anthropic" ? "gpt-6-sol" : "claude-opus-5"]);
      await s.built.config.flushScope("org:default-org");
      await s.built.userModelCredentials.setOAuth("U1", provider, {
        accessToken: "synthetic-subscription-token",
        expiresAt: Date.now() + 3_600_000,
      });
      await s.built.config.setPersonalModelAuth("U1", true, provider);
      const harnessId = provider === "anthropic" ? "claude" : "codex";
      const modelId = provider === "anthropic" ? "claude-sonnet-5" : "gpt-6-sol";
      const snapshot = await s.get();
      assert.ok(snapshot.modelsByHarness[harnessId]?.includes(modelId));
      assert.equal(snapshot.unavailableReason, undefined);
      assert.ok(snapshot.modelsByHarness[snapshot.effective.harnessId]?.includes(snapshot.effective.modelId));
      const saved = await s.put({ harnessId, modelId, effortLevel: "high", fastMode: false });
      assert.equal(saved.status, 200);
      assert.equal((await s.get()).effective.modelId, modelId);
      assert.deepEqual((await s.get("U2")).modelsByHarness, {});
      const submitted = await s.built.app.turn({
        surface: "web",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: `web:U1:subscription-${provider}` },
        text: "hello",
        liveActor: true,
        async: true,
        harness: harnessId,
        model: modelId,
      });
      assert.ok(submitted.runId, JSON.stringify(submitted));
      const scheduled = await s.built.app.turn({
        surface: "cron",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: `cron-subscription-${provider}` },
        text: "hello",
        triggered: true,
        async: true,
        harness: harnessId,
        model: modelId,
      });
      assert.ok(scheduled.runId, JSON.stringify(scheduled));
      const service = createRuntimeService(
        { config: s.built.config, userModelCredentials: s.built.userModelCredentials },
        { authorizesCapabilityScope: async () => true },
      );
      const active = { harnessId, modelId, effortLevel: "auto", fastMode: false } as const;
      const changed = await service(
        { actorId: "U1", scopeId: "personal:U1", liveActor: true, exp: Date.now() + 60_000 },
        active,
        { action: "set", effort: "high" },
        async () => null,
        true,
      );
      assert.equal(changed.ok, true);
      await s.built.userModelCredentials.delete("U1", provider);
      assert.deepEqual((await s.get()).modelsByHarness, {});
      assert.equal((await s.put({ harnessId, modelId })).status, 400);
    } finally {
      await s.close();
    }
  });
}

test("a legacy mixed personal account keeps API-key restrictions while exposing subscription models", async () => {
  const s = await setup();
  try {
    s.built.config.setApprovedHarnesses(["pi"]);
    s.built.config.setWebuiModels("org:default-org", ["gpt-6-sol"]);
    await s.built.config.flushScope("org:default-org");
    await s.built.userModelCredentials.setApiKey("U1", "anthropic", "synthetic-anthropic-key");
    await s.built.userModelCredentials.setOAuth("U1", "openai", { accessToken: "synthetic-subscription-token" });
    await s.built.config.setPersonalModelAuth("U1", true);
    const snapshot = await s.get();
    assert.ok(snapshot.modelsByHarness.codex?.includes("gpt-6-astra"));
    assert.ok(!snapshot.modelsByHarness.pi?.includes("claude-sonnet-5"));
    assert.equal((await s.put({ harnessId: "pi", modelId: "claude-sonnet-5" })).status, 400);
  } finally {
    await s.close();
  }
});
