import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAgentService,
  validateAgentPackage,
  type AgentPackage,
  type CustomAgent,
  type AgentBinding,
} from "../src/agents/agent-service.ts";
import { allowsAgentTool, exposesAgentTool, agentApiOperation } from "../src/agents/tool-policy.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createProjectStore, projectScopeId } from "../src/projects/project-store.ts";
const pkg: AgentPackage = {
  name: "Network engineer",
  description: "Network troubleshooting",
  instructions: "Inspect first. Ask before changing devices.",
  files: [{ path: "references/runbook.md", content: "Check routes" }],
  allowedTools: ["files.read"],
  requiredTools: [],
  examples: [{ task: "Check connectivity", expected: "Report evidence" }],
};
async function fixture(retire: (id: string) => Promise<unknown> = async () => {}) {
  const agents = createMemoryMap<CustomAgent>();
  const bindings = createMemoryMap<AgentBinding>();
  const projects = createProjectStore();
  const project = await projects.create({ name: "Infra", ownerId: "owner" });
  await projects.addMember(project.id, "owner", "member");
  const scope = projectScopeId(project.id);
  const archived = new Set<string>();
  const canRead = async (actor: string, home: string) =>
    home === `personal:${actor}` || (home === scope && ["owner", "member"].includes(actor));
  const options = {
    agents,
    bindings,
    projects,
    bytes: createMemoryDurableByteStore(),
    lock: createMemoryAdvisoryLock(),
    acl: createAclStore(),
    audit: createAuditLog(),
    active: async (s: string) => !archived.has(s),
    write: async <T>(scopes: readonly string[], fn: () => Promise<T>) => {
      if (scopes.some((s) => archived.has(s))) throw new Error("Archived");
      return fn();
    },
    canRead,
    canWrite: async (a: string, s: string) => !archived.has(s) && canRead(a, s),
    internal: (a: string) => ["owner", "member", "recipient", "outsider"].includes(a),
    retire,
  };
  return { service: createAgentService(options), options, scope, archived };
}
test("immutable revisions survive service reconstruction, no-op saves and concurrent saves", async () => {
  const f = await fixture();
  let a = await f.service.create("owner", "personal:owner", pkg);
  assert.equal(a.publishedVersion, null);
  assert.equal(a.version, 1);
  await f.service.publish("owner", a.id, 1);
  a = await f.service.save("owner", a.id, pkg, 1);
  assert.equal(a.version, 1);
  const saves = await Promise.allSettled([
    f.service.save("owner", a.id, { ...pkg, instructions: "v2" }, 1),
    f.service.save("owner", a.id, { ...pkg, instructions: "other" }, 1),
  ]);
  assert.equal(saves.filter((s) => s.status === "fulfilled").length, 1);
  assert.equal(saves.filter((s) => s.status === "rejected").length, 1);
  const restarted = createAgentService(f.options);
  const first = await restarted.view("owner", a.id, 1);
  assert.equal(first.package.instructions, pkg.instructions);
  assert.equal(first.package.files[0]!.content, "Check routes");
  const restored = await restarted.restore("owner", a.id, 1, 2);
  assert.equal(restored.version, 3);
  assert.equal(restored.publishedVersion, 1);
});
test("Users run published revisions, Contributors edit; sharing never exposes drafts", async () => {
  const { service } = await fixture();
  let a = await service.create("owner", "personal:owner", pkg);
  await service.share("owner", a.id, "personal:recipient", "user");
  await assert.rejects(service.view("recipient", a.id));
  await service.publish("owner", a.id, 1);
  a = await service.save("owner", a.id, { ...pkg, instructions: "private draft" }, 1);
  const shared = await service.view("recipient", a.id);
  assert.equal(shared.package.instructions, pkg.instructions);
  assert.equal(shared.canEdit, false);
  assert.equal(shared.proposals.length, 0);
  await assert.rejects(service.view("recipient", a.id, 2));
  await assert.rejects(service.save("recipient", a.id, pkg, 2));
  await assert.rejects(service.admit("recipient", "personal:recipient", { id: a.id, version: 2, test: true }));
  await service.propose("recipient", a.id, "Improve diagnostics");
  assert.equal((await service.view("owner", a.id)).proposals.length, 1);
  await service.share("owner", a.id, "personal:recipient", "contributor");
  assert.equal((await service.view("recipient", a.id)).canEdit, true);
  await service.publish("recipient", a.id, 2);
  assert.equal(
    (await service.admit("recipient", "personal:recipient", { id: a.id, version: 1 })).package.instructions,
    pkg.instructions,
  );
  await assert.rejects(service.share("recipient", a.id, "personal:outsider", "user"));
  await service.share("owner", a.id, "personal:recipient", null);
  await assert.rejects(service.admit("recipient", "personal:recipient", { id: a.id, version: 1 }));
});
test("Project grants honor acting workspace and upgrade members to Contributor", async () => {
  const { service, scope } = await fixture();
  const own = await service.create("owner", scope, pkg);
  await service.publish("owner", own.id, 1);
  assert.equal((await service.view("member", own.id)).canEdit, false);
  await service.share("owner", own.id, "personal:member", "contributor");
  assert.equal((await service.view("member", own.id)).canEdit, true);
  await assert.rejects(service.share("member", own.id, "personal:outsider", "user"));
  const personal = await service.create("owner", "personal:owner", pkg);
  await service.publish("owner", personal.id, 1);
  await service.share("owner", personal.id, scope, "user");
  await service.admit("member", scope, { id: personal.id, version: 1 });
  await assert.rejects(service.admit("member", "personal:member", { id: personal.id, version: 1 }));
});
test("Deletion retries cleanup, removes defaults and shared access, retains owner history", async () => {
  let failed = true;
  let retired = 0;
  const { service } = await fixture(async () => {
    if (failed) throw new Error("Temporary queue failure");
    retired++;
  });
  const a = await service.create("owner", "personal:owner", pkg);
  await service.publish("owner", a.id, 1);
  await service.share("owner", a.id, "personal:recipient", "user");
  await service.bind("recipient", "default:personal:recipient", "personal:recipient", { id: a.id, version: 1 });
  await assert.rejects(service.delete("recipient", a.id, true));
  await assert.rejects(service.delete("owner", a.id, false));
  await assert.rejects(service.delete("owner", a.id, true));
  assert.equal((await service.view("owner", a.id)).deleted, true);
  failed = false;
  await service.recoverDeletions();
  await service.delete("owner", a.id, true);
  assert.equal(retired, 2);
  assert.equal(await service.binding("default:personal:recipient", "personal:recipient"), null);
  await assert.rejects(service.view("recipient", a.id));
  await assert.rejects(service.admit("owner", "personal:owner", { id: a.id, version: 1 }));
  assert.equal((await service.list("owner")).length, 0);
  assert.equal((await service.list("owner", undefined, true)).length, 1);
});
test("Binding and deletion serialize so a deleted default cannot be restored", async () => {
  const { service } = await fixture();
  const a = await service.create("owner", "personal:owner", pkg);
  await service.publish("owner", a.id, 1);
  await Promise.allSettled([
    service.bind("owner", "default:personal:owner", "personal:owner", { id: a.id, version: 1 }),
    service.delete("owner", a.id, true),
  ]);
  assert.equal((await service.binding("default:personal:owner", "personal:owner")) ?? null, null);
});
test("Archived projects freeze owned agents without deleting independently shared packages", async () => {
  const { service, scope, archived } = await fixture();
  const owned = await service.create("owner", scope, pkg);
  await service.publish("owner", owned.id, 1);
  const personal = await service.create("owner", "personal:owner", pkg);
  await service.publish("owner", personal.id, 1);
  await service.share("owner", personal.id, scope, "user");
  archived.add(scope);
  const retained = await service.view("owner", owned.id);
  assert.equal(retained.available, false);
  assert.equal(retained.canEdit, false);
  await assert.rejects(service.save("owner", owned.id, pkg, 1));
  await assert.rejects(service.admit("owner", scope, { id: owned.id, version: 1 }));
  assert.equal((await service.view("owner", personal.id)).available, true);
  await assert.rejects(service.admit("member", scope, { id: personal.id, version: 1 }));
});
test("Tool restrictions enforce actions and deny delegation/API action spoofing", () => {
  assert.equal(allowsAgentTool(["files.read"], "files", "read"), true);
  assert.equal(allowsAgentTool(["files.read"], "files", "write"), false);
  assert.equal(exposesAgentTool(["files.read"], "files"), true);
  assert.equal(allowsAgentTool(["subagents", "runtime", "cron"], "subagents", "open"), false);
  assert.equal(allowsAgentTool([], "agent_package"), true);
  for (const [method, path] of [
    ["DELETE", "/v1/agents/a"],
    ["POST", "/v1/agents"],
    ["PUT", "/v1/skills/a"],
    ["POST", "/v1/blobs"],
  ]) {
    const operation = agentApiOperation(method!, path!, { action: "read", confirm: true })!;
    assert.equal(allowsAgentTool([`${operation.name}.read`], operation.name, operation.action), false);
  }
  assert.equal(agentApiOperation("POST", "/v1/agents/binding", {}), null);
  assert.throws(() => validateAgentPackage({ ...pkg, files: [{ path: "../escape", content: "x" }] }));
});

test("effective selection inherits latest release only for new chats and preserves explicit Default QM", async () => {
  const { service } = await fixture();
  const a = await service.create("owner", "personal:owner", pkg);
  await service.publish("owner", a.id, 1);
  await service.bind("owner", "default:personal:owner", "personal:owner", { id: a.id, version: 1 });
  await service.bind("owner", "selection:web:owner:pinned", "personal:owner", { id: a.id, version: 1 });
  await service.save("owner", a.id, { ...pkg, instructions: "New release" }, 1);
  await service.publish("owner", a.id, 2);
  assert.equal((await service.effectiveSelection("owner", "personal:owner", "web:owner:new"))!.version, 2);
  assert.equal((await service.effectiveSelection("owner", "personal:owner", "web:owner:pinned"))!.version, 1);
  await service.bind("owner", "selection:web:owner:reset", "personal:owner", null);
  assert.equal(await service.effectiveSelection("owner", "personal:owner", "web:owner:reset"), null);
});
test("retiring one agent cannot overwrite a newer default pointing at another", async () => {
  const { service, options } = await fixture();
  const a = await service.create("owner", "personal:owner", pkg);
  const b = await service.create("owner", "personal:owner", { ...pkg, name: "ZStack specialist" });
  await service.publish("owner", a.id, 1);
  await service.publish("owner", b.id, 1);
  await service.bind("owner", "default:personal:owner", "personal:owner", { id: a.id, version: 1 });
  const entries = options.bindings.entries.bind(options.bindings);
  let race = true;
  options.bindings.entries = async () => {
    const snapshot = await entries();
    if (race) {
      race = false;
      await service.bind("owner", "default:personal:owner", "personal:owner", { id: b.id, version: 1 });
    }
    return snapshot;
  };
  await service.delete("owner", a.id, true);
  assert.equal((await service.binding("default:personal:owner", "personal:owner"))!.id, b.id);
});

test("role changes replace recipient grants, so Contributor downgrade removes edit access", async () => {
  const { service } = await fixture();
  const a = await service.create("owner", "personal:owner", pkg);
  await service.publish("owner", a.id, 1);
  await service.share("owner", a.id, "personal:recipient", "user");
  await service.share("owner", a.id, "personal:recipient", "contributor");
  assert.equal((await service.grants("owner", a.id)).length, 1);
  assert.equal((await service.view("recipient", a.id)).canEdit, true);
  await service.share("owner", a.id, "personal:recipient", "user");
  assert.equal((await service.grants("owner", a.id)).length, 1);
  assert.equal((await service.view("recipient", a.id)).canEdit, false);
  await assert.rejects(service.save("recipient", a.id, { ...pkg, instructions: "Unauthorized" }, 1));
});
