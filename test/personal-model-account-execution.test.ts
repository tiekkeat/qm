import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as piHarness from "../src/harness/pi-harness.ts";
import * as claudeHarness from "../src/harness/claude-harness.ts";
import * as codexHarness from "../src/harness/codex-harness.ts";
import * as mockHarness from "../src/harness/mock-harness.ts";
import type { HarnessTurnInput } from "../src/harness/harness.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { testConfig } from "./support/test-config.ts";

const turns: HarnessTurnInput[] = [];
function observedHarness() {
  const harness = mockHarness.createMockHarness();
  const runTurn = harness.turns.runTurn;
  harness.turns.runTurn = async (turn) => {
    turns.push(turn);
    return runTurn(turn);
  };
  return harness;
}

mock.module("../src/harness/pi-harness.ts", {
  namedExports: { ...piHarness, createPiHarness: observedHarness },
});
mock.module("../src/harness/mock-harness.ts", {
  namedExports: { ...mockHarness, createMockHarness: observedHarness },
});
mock.module("../src/harness/claude-harness.ts", {
  namedExports: { ...claudeHarness, createClaudeHarness: observedHarness },
});
mock.module("../src/harness/codex-harness.ts", {
  namedExports: { ...codexHarness, createCodexHarness: observedHarness },
});
const { buildApp } = await import("../src/wiring.ts");

for (const provider of ["anthropic", "openai"] as const) {
  test(`queued personal ${provider} turns use only that provider's credentials after switching to company`, async () => {
    turns.length = 0;
    const built = buildApp(testConfig({ anthropicApiKey: "company-anthropic", openaiApiKey: "company-openai" }));
    await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-anthropic");
    await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
    await built.config.setPersonalModelAuth("U1", true, provider);
    const submitted = await built.app.turn({
      surface: "slack",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `execute-personal-${provider}` },
      text: "hello",
      liveActor: true,
      async: true,
    });
    await built.config.setPersonalModelAuth("U1", false);
    built.runtime.start();
    try {
      const finished = await built.runs.waitFor(submitted.runId!, 5_000);
      assert.equal(finished.status, "done", JSON.stringify(finished.result));
      assert.equal(turns.length, 1);
      assert.deepEqual(turns[0]!.providerKeys, { [provider]: `personal-${provider}` });
      assert.equal(resolveModel(turns[0]!.runtime!.modelId!)?.provider, provider);
      assert.equal(turns[0]!.runtime!.harnessId, "pi");
    } finally {
      await built.runtime.stop();
    }
  });
}

test("disconnecting a queued personal account fails without invoking any main harness or another connected provider", async () => {
  turns.length = 0;
  const built = buildApp(testConfig({ anthropicApiKey: "company-anthropic", openaiApiKey: "company-openai" }));
  await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-anthropic");
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "execute-disconnected-personal" },
    text: "hello",
    liveActor: true,
    async: true,
  });
  await built.userModelCredentials.delete("U1", "openai");
  await built.config.setPersonalModelAuth("U1", false);
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "failed");
    assert.match(JSON.stringify(finished), /personal AI account is unavailable/);
    assert.equal(turns.length, 0);
  } finally {
    await built.runtime.stop();
  }
});

for (const account of ["personal", "openai", "anthropic"] as const) {
  test(`web ${account} account honors the chosen model, effort and fast mode`, async () => {
    turns.length = 0;
    const provider = account === "anthropic" ? "anthropic" : "openai";
    const model = provider === "anthropic" ? "claude-sonnet-5" : "gpt-5.6-terra";
    const built = buildApp(testConfig({ openaiApiKey: "company-openai" }));
    built.config.setApprovedHarnesses(["pi"]);
    await built.config.flushScope("org:default-org");
    await built.userModelCredentials.setApiKey("U1", provider, `personal-${provider}`);
    await built.config.setPersonalModelAuth("U1", true, account === "personal" ? undefined : account);
    const submitted = await built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `web:U1:picker-${account}` },
      text: "hello",
      liveActor: true,
      async: true,
      model,
      harness: "pi",
      thinkingLevel: "high",
      fastMode: true,
    });
    assert.ok(submitted.runId, JSON.stringify(submitted));
    const queued = await built.runs.get(submitted.runId!);
    assert.equal(queued?.request.model, model);
    assert.equal(queued?.request.harness, "pi");
    built.runtime.start();
    try {
      const finished = await built.runs.waitFor(submitted.runId!, 5_000);
      assert.equal(finished.status, "done", JSON.stringify(finished.result));
      assert.equal(turns.length, 1);
      assert.deepEqual(turns[0]!.providerKeys, { [provider]: `personal-${provider}` });
      assert.deepEqual(turns[0]!.runtime, {
        harnessId: "pi",
        modelId: model,
        effortLevel: "high",
        fastMode: true,
      });
    } finally {
      await built.runtime.stop();
    }
  });
}

test("personal web selections reject wrong providers, harnesses, policy exclusions and disconnected keys", async () => {
  const built = buildApp(testConfig({ openaiApiKey: "company-openai", anthropicApiKey: "company-anthropic" }));
  built.config.setApprovedHarnesses(["pi", "claude"]);
  await built.config.flushScope("org:default-org");
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submit = (model: string, harness = "pi") =>
    built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `web:U1:invalid-${crypto.randomUUID()}` },
      text: "hello",
      liveActor: true,
      async: true,
      model,
      harness,
    });
  for (const [model, harness] of [
    ["claude-sonnet-5", "pi"],
    ["gpt-5.6-terra", "claude"],
    ["unknown", "pi"],
  ])
    assert.equal((await submit(model!, harness!)).status, "refused");
  built.config.setWebuiModels("org:default-org", ["gpt-5.6-sol"]);
  await built.config.flushScope("org:default-org");
  assert.equal((await submit("gpt-5.6-terra")).status, "refused");
  await built.userModelCredentials.delete("U1", "openai");
  assert.equal((await submit("gpt-5.6-sol")).status, "refused");
});

test("a queued web selection cannot fall back to another personal provider after disconnect", async () => {
  turns.length = 0;
  const built = buildApp(testConfig());
  built.config.setApprovedHarnesses(["pi"]);
  await built.config.flushScope("org:default-org");
  await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-anthropic");
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setPersonalModelAuth("U1", true);
  const submitted = await built.app.turn({
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:disconnect-after-pick" },
    text: "hello",
    liveActor: true,
    async: true,
    model: "gpt-5.6-terra",
    harness: "pi",
  });
  assert.ok(submitted.runId, JSON.stringify(submitted));
  await built.userModelCredentials.delete("U1", "openai");
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "failed");
    assert.match(JSON.stringify(finished), /cannot serve this model/);
    assert.equal(turns.length, 0);
  } finally {
    await built.runtime.stop();
  }
});

test("web subscription selections use the namespaced model and personal OAuth on Pi", async () => {
  turns.length = 0;
  const built = buildApp(testConfig());
  built.config.setApprovedHarnesses(["pi"]);
  await built.config.flushScope("org:default-org");
  await built.userModelCredentials.setOAuth("U1", "openai", {
    accessToken: "personal-oauth",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submitted = await built.app.turn({
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:oauth-picker" },
    text: "hello",
    liveActor: true,
    async: true,
    model: "codex/gpt-5.6-terra",
    harness: "pi",
    thinkingLevel: "high",
    fastMode: false,
  });
  assert.ok(submitted.runId, JSON.stringify(submitted));
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "done", JSON.stringify(finished.result));
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0]!.providerKeys, { "openai-codex": "personal-oauth" });
    assert.deepEqual(turns[0]!.runtime, {
      harnessId: "pi",
      modelId: "codex/gpt-5.6-terra",
      effortLevel: "high",
      fastMode: false,
    });
  } finally {
    await built.runtime.stop();
  }
});

test("partial personal web choices queue the complete validated scoped runtime", async () => {
  const built = buildApp(testConfig());
  built.config.setApprovedHarnesses(["pi", "codex"]);
  await built.config.setRuntimeSelectionLatest("org:default-org", { harnessId: "pi", modelId: "gpt-5.6-sol" });
  await built.config.setRuntimeSelectionLatest("personal:U1", { harnessId: "pi", modelId: "gpt-5.6-terra" });
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submit = (choice: { harness?: string; model?: string }) =>
    built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `web:U1:partial-${crypto.randomUUID()}` },
      text: "hello",
      liveActor: true,
      async: true,
      ...choice,
    });
  const first = await submit({ harness: "pi" });
  assert.ok(first.runId, JSON.stringify(first));
  const queued = await built.runs.get(first.runId!);
  assert.equal(queued?.request.harness, "pi");
  assert.equal(queued?.request.model, "gpt-5.6-terra");
  await built.userModelCredentials.delete("U1", "openai");
  await built.userModelCredentials.setOAuth("U1", "openai", {
    accessToken: "personal-oauth",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setRuntimeSelectionLatest("personal:U1", { harnessId: "codex", modelId: "gpt-5.6-sol" });
  const second = await submit({ model: "gpt-5.6-terra" });
  assert.ok(second.runId, JSON.stringify(second));
  const oauth = await built.runs.get(second.runId!);
  assert.equal(oauth?.request.harness, "codex");
  assert.equal(oauth?.request.model, "gpt-5.6-terra");
});

for (const provider of ["anthropic", "openai"] as const) {
  for (const scheduled of [false, true]) {
    test(`personal ${provider} subscription executes ${scheduled ? "scheduled" : "web"} work despite organization restrictions`, async () => {
      turns.length = 0;
      const built = buildApp(testConfig());
      built.config.setApprovedHarnesses(["pi"]);
      built.config.setWebuiModels("org:default-org", [provider === "anthropic" ? "gpt-6-sol" : "claude-opus-5"]);
      await built.config.flushScope("org:default-org");
      if (scheduled)
        await built.config.setPurposeRuntime("cron", {
          harnessId: "pi",
          modelId: provider === "anthropic" ? "gpt-6-sol" : "claude-opus-5",
          effortLevel: "low",
          fastMode: false,
        });
      const jwtPart = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
      await built.userModelCredentials.setOAuth("U1", provider, {
        accessToken: "personal-subscription-access",
        refreshToken: "personal-subscription-refresh",
        expiresAt: Date.now() + 3_600_000,
        idToken: `${jwtPart({ alg: "RS256" })}.${jwtPart({ "https://api.openai.com/auth": { chatgpt_account_id: "personal-test" } })}.sig`,
      });
      await built.config.setPersonalModelAuth("U1", true, provider);
      const harness = provider === "anthropic" ? "claude" : "codex";
      const model = provider === "anthropic" ? "claude-sonnet-5" : "gpt-6-sol";
      const submitted = await built.app.turn({
        surface: scheduled ? "cron" : "web",
        actor: { externalId: "U1" },
        conversation: { kind: "dm", threadRef: `${scheduled ? "cron" : "web:U1"}:independent-${provider}` },
        text: "hello",
        liveActor: !scheduled,
        triggered: scheduled,
        async: true,
        harness,
        model,
        thinkingLevel: "high",
        fastMode: false,
      });
      assert.ok(submitted.runId, JSON.stringify(submitted));
      const queued = await built.runs.get(submitted.runId!);
      assert.equal(queued?.request.modelAccount, provider);
      assert.equal(queued?.request.model, model);
      assert.equal(queued?.request.harness, harness);
      await built.config.setPersonalModelAuth("U1", false);
      built.runtime.start();
      try {
        const finished = await built.runs.waitFor(submitted.runId!, 5000);
        assert.equal(finished.status, "done", JSON.stringify(finished.result));
        assert.equal(turns.length, 1);
        assert.equal(turns[0]!.runtime!.harnessId, harness);
        assert.equal(turns[0]!.runtime!.modelId, model);
        if (provider === "anthropic") assert.equal(turns[0]!.claudeOauthToken, "personal-subscription-access");
        else assert.equal(turns[0]!.codexAuth?.accessToken, "personal-subscription-access");
      } finally {
        await built.runtime.stop();
      }
    });
  }
}
