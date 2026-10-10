import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { testConfig, TEST_CAPABILITY_SECRET } from "./support/test-config.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";
import type { AddressInfo } from "node:net";
const pkg = {
  name: "Network engineer",
  description: "Incident diagnostics",
  instructions: "AGENT-QUARTZ-731 inspect routing",
  files: [],
  allowedTools: null,
  requiredTools: [],
  examples: [],
};
async function setup() {
  const built = buildApp(testConfig());
  await built.directory.replace([{ principalId: "U1", displayName: "Owner", type: "internal" }]);
  await built.identity.refresh(true);
  return built;
}
test("chat selects a pinned revision, records attribution, and resets through /agent default", async () => {
  const built = await setup();
  try {
    const a = await built.customAgents.create("U1", "personal:U1", pkg);
    await built.customAgents.publish("U1", a.id, 1);
    const req = {
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm" as const, threadRef: "dm:U1:custom-agent" },
    };
    const first = await built.app.turn({ ...req, text: `/agent ${a.slug} inspect routing` });
    assert.equal(first.status, "ok");
    const requests = await built.sessions.listLlmRequests(first.sessionId!);
    assert.match(JSON.stringify(requests), /AGENT-QUARTZ-731/);
    const user = (await built.sessions.getEntries(first.sessionId!)).find((e) => e.type === "user")!;
    assert.deepEqual((user.payload as { customAgent: unknown }).customAgent, { id: a.id, version: 1 });
    await built.customAgents.save("U1", a.id, { ...pkg, instructions: "AGENT-NEW-V2" }, 1);
    await built.customAgents.publish("U1", a.id, 2);
    const next = await built.app.turn({ ...req, text: "Follow up" });
    assert.equal(next.status, "ok");
    assert.equal(
      (await built.customAgents.effectiveSelection("U1", "personal:U1", req.conversation.threadRef))!.version,
      1,
    );
    const reset = await built.app.turn({ ...req, text: "/agent default continue" });
    assert.equal(reset.status, "ok");
    assert.equal(await built.customAgents.effectiveSelection("U1", "personal:U1", req.conversation.threadRef), null);
  } finally {
    await built.runtime.stop();
  }
});
test("required capabilities are checked against the restricted runtime tool set", async () => {
  const built = await setup();
  try {
    const a = await built.customAgents.create("U1", "personal:U1", {
      ...pkg,
      allowedTools: ["cron"],
      requiredTools: ["cron"],
    });
    await built.customAgents.publish("U1", a.id, 1);
    const result = await built.app.turn({
      surface: "test",
      actor: { externalId: "U1" },
      conversation: { kind: "dm", threadRef: "dm:U1:required" },
      text: "Inspect",
      customAgent: { id: a.id, version: 1 },
    });
    assert.equal(result.status, "refused");
    assert.match(result.reason!, /Missing agent capabilities: cron/);
  } finally {
    await built.runtime.stop();
  }
});
test("capability HTTP paths deny read-only action spoofing, binding changes, and generic agent grants", async () => {
  const built = await setup();
  const server = createInsecureTestServer(built.app, { capabilitySecret: TEST_CAPABILITY_SECRET });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const a = await built.customAgents.create("U1", "personal:U1", pkg);
    const token = await mintCapabilityToken(
      {
        actorId: "U1",
        scopeId: "personal:U1",
        exp: Date.now() + 60_000,
        liveAuthor: true,
        agentTools: ["agents.read", "skills.read"],
      },
      TEST_CAPABILITY_SECRET,
    );
    for (const [method, path, body] of [
      ["DELETE", `/v1/agents/${a.id}`, { action: "read", confirm: true }],
      ["POST", "/v1/agents", { action: "read", package: pkg }],
      ["PUT", "/v1/skills/a", { action: "read", body: "changed" }],
      ["POST", "/v1/agents/binding", { threadRef: "web:U1:qa", selection: null }],
    ] as const) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { "x-agent-capability": token, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 403, `${method} ${path}`);
    }
    assert.equal((await built.customAgents.view("U1", a.id)).deleted, false);
    await assert.rejects(
      built.app.grant({
        ownerScopeId: "personal:U1",
        ref: `agent:${a.id}`,
        granteeScopeId: "personal:U2",
        permission: "write",
        grantedBy: "U1",
      }),
      /agent sharing API/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});
