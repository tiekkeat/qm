import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as claudeHarness from "../src/harness/claude-harness.ts";
import * as codexHarness from "../src/harness/codex-harness.ts";
import * as mockHarness from "../src/harness/mock-harness.ts";
import * as agentRun from "../src/agent/agent-run.ts";
import * as mockAgent from "./support/mock-agent.ts";
import type { AgentTurnInput } from "../src/agent/agent.ts";
import { resolveModel } from "../src/model/pi-models.ts";
import { testConfig } from "./support/test-config.ts";
import { COMPANY_CHATGPT_CREDENTIAL, saveCompanyChatGPTLogin } from "./support/company-chatgpt-login.ts";

const turns: AgentTurnInput[] = [];
let piOptions: Parameters<typeof agentRun.createAgent>[0];
function observedCreateAgent(opts: Parameters<typeof agentRun.createAgent>[0]) {
  piOptions = opts;
  return observedAgent();
}
function observedHarness() {
  const harness = mockHarness.createMockHarness();
  const runTurn = harness.turns.runTurn.bind(harness.turns);
  harness.turns.runTurn = async (turn) => {
    turns.push(turn as unknown as AgentTurnInput);
    return runTurn(turn);
  };
  return harness;
}
function observedAgent() {
  const agent = mockAgent.createMockAgent();
  const runTurn = agent.runTurn;
  agent.runTurn = async (turn) => {
    turns.push(turn);
    return runTurn(turn);
  };
  return agent;
}

mock.module("../src/agent/agent-run.ts", {
  namedExports: { ...agentRun, createAgent: observedCreateAgent },
});
mock.module("../src/harness/claude-harness.ts", {
  namedExports: { ...claudeHarness, createClaudeHarness: observedHarness },
});
mock.module("../src/harness/codex-harness.ts", {
  namedExports: { ...codexHarness, createCodexHarness: observedHarness },
});
const { stopAtEnd } = await import("./support/build-app.ts");
const { buildApp: buildProductionApp } = await import("../src/wiring.ts");
const buildApp = (...args: Parameters<typeof buildProductionApp>) => stopAtEnd(buildProductionApp(...args));

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
      origin: { kind: "human" },
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
    } finally {
      await built.runtime.stop();
    }
  });
}

test("disconnecting a queued personal account fails without invoking any main agent or another connected provider", async () => {
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
    origin: { kind: "human" },
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
    await built.userModelCredentials.setApiKey("U1", provider, `personal-${provider}`);
    await built.config.setPersonalModelAuth("U1", true, account === "personal" ? undefined : account);
    const submitted = await built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `web:U1:picker-${account}` },
      text: "hello",
      origin: { kind: "human" },
      async: true,
      model,
      thinkingLevel: "high",
      fastMode: true,
    });
    assert.ok(submitted.runId, JSON.stringify(submitted));
    const queued = await built.runs.get(submitted.runId!);
    assert.equal(queued?.request.model, model);
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

test("personal web selections reject wrong providers, policy exclusions and disconnected keys", async (t) => {
  const built = buildApp(testConfig({ openaiApiKey: "company-openai", anthropicApiKey: "company-anthropic" }));
  t.after(() => built.runtime.stop());
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submit = (model: string) =>
    built.app.turn({
      surface: "web",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: `web:U1:invalid-${crypto.randomUUID()}` },
      text: "hello",
      origin: { kind: "human" },
      async: true,
      model,
    });
  for (const model of ["claude-sonnet-5", "unknown"])
    assert.deepEqual(await submit(model), {
      status: "refused",
      reason: "Your connected AI account cannot serve this model.",
    });
  await built.config.setWebuiModels("org:default-org", ["gpt-5.6-sol"]);
  assert.equal((await submit("gpt-5.6-terra")).status, "refused");
  await built.userModelCredentials.delete("U1", "openai");
  assert.equal((await submit("gpt-5.6-sol")).status, "refused");
});

test("a queued web selection cannot fall back to another personal provider after disconnect", async () => {
  turns.length = 0;
  const built = buildApp(testConfig());
  await built.userModelCredentials.setApiKey("U1", "anthropic", "personal-anthropic");
  await built.userModelCredentials.setApiKey("U1", "openai", "personal-openai");
  await built.config.setPersonalModelAuth("U1", true);
  const submitted = await built.app.turn({
    surface: "web",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "web:U1:disconnect-after-pick" },
    text: "hello",
    origin: { kind: "human" },
    async: true,
    model: "gpt-5.6-terra",
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
    origin: { kind: "human" },
    async: true,
    model: "codex/gpt-5.6-terra",
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

test("a company ChatGPT login feeds pi's subscription provider while personal ChatGPT OAuth turns use their own token", async () => {
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }));
  const companyToken = `e30.${claims.toString("base64url")}.sig`;
  turns.length = 0;
  const built = buildApp(testConfig({ codexAuthCredential: COMPANY_CHATGPT_CREDENTIAL }));
  await saveCompanyChatGPTLogin(built.keychain, {
    auth_mode: "chatgpt",
    tokens: { access_token: companyToken, refresh_token: "r" },
  });
  assert.equal((await piOptions!.routes!.route("gpt-5.6-sol")).keys["openai-codex"], companyToken);
  assert.equal(piOptions?.routes?.servedId("gpt-5.6-sol"), "codex/gpt-5.6-sol");
  assert.equal(piOptions?.routes?.servedId("gpt-6-astra-ultrafast"), "gpt-6-astra-ultrafast");
  assert.equal(piOptions?.routes?.servedId("claude-opus-5"), "claude-opus-5");
  await built.userModelCredentials.setOAuth("U1", "openai", {
    accessToken: "personal-oauth",
    expiresAt: Date.now() + 3_600_000,
  });
  await built.config.setPersonalModelAuth("U1", true, "openai");
  const submitted = await built.app.turn({
    surface: "slack",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "legacy-bare-pin" },
    text: "hello",
    origin: { kind: "human" },
    async: true,
  });
  assert.ok(submitted.runId, JSON.stringify(submitted));
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(submitted.runId!, 5_000);
    assert.equal(finished.status, "done", JSON.stringify(finished.result));
    assert.deepEqual(turns[0]!.providerKeys, { "openai-codex": "personal-oauth" });
    assert.equal(turns[0]!.runtime!.modelId, "codex/gpt-6.1-sol");
  } finally {
    await built.runtime.stop();
  }
});

test("a configured company subscription without a keychain cannot fall back to the metered key", () => {
  assert.throws(
    () =>
      buildApp(
        testConfig({
          connectorSecretKey: undefined,
          codexAuthCredential: "unavailable",
          openaiApiKey: "metered",
          modelId: "gpt-5.6-sol",
        }),
      ),
    /CONNECTOR_SECRET_KEY is required/,
  );
});

for (const provider of ["anthropic", "openai"] as const) {
  for (const scheduled of [false, true]) {
    test(`personal ${provider} subscription executes ${scheduled ? "scheduled" : "web"} work despite organization restrictions`, async () => {
      turns.length = 0;
      const built = buildApp(testConfig());
      built.config.setApprovedHarnesses(["pi"]);
      built.config.setWebuiModels("org:default-org", [provider === "anthropic" ? "gpt-6-sol" : "claude-opus-5"]);
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
        origin: scheduled ? { kind: "automation" } : { kind: "human" },
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
