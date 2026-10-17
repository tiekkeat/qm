import assert from "node:assert/strict";
import { test } from "node:test";
import { createProjectStore, projectGroupRef, projectScopeId } from "../src/projects/project-store.ts";
import { createProjectScopeGuard } from "../src/projects/project-scope-guard.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createSandboxResources, type SandboxResource, type SandboxDefault } from "../src/sandbox/sandbox-resources.ts";
import { createSandboxRouter } from "../src/sandbox/sandbox-routing.ts";
import { createMemoryProcessRegistry } from "../src/processes/process-registry.ts";
import { createSandboxMethods } from "../src/api/app-sandboxes.ts";
import type { AppDeps } from "../src/api/app-types.ts";
import type { AppHelpers } from "../src/api/app-helpers.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";
import { createSkillStore } from "../src/skills/skill-store.ts";
import { createCanReadScope, createCanWriteScope } from "../src/resolution/scope-membership.ts";
import type { MemoryService } from "../src/memory/memory-service.ts";

async function fixture() {
  const lock = createMemoryAdvisoryLock();
  const projects = createProjectStore(undefined, { id: () => "p1", advisoryLock: lock });
  await projects.create({ name: "Launch", ownerId: "owner" });
  await projects.addMember("p1", "owner", "member");
  const scope = projectScopeId("p1");
  const records = createMemoryMap<SandboxResource>();
  const defaults = createMemoryMap<SandboxDefault>();
  const processes = createMemoryProcessRegistry();
  const destroyed: string[] = [];
  let failDestroy = false;
  const backend: Sandbox = {
    profile: { backend: "local", processSessions: true, writablePersistence: "resident_disk" },
    async provision(layers) {
      return { id: layers[0]!.scopeId, rootDir: "/workspace" };
    },
    async run() {
      return { stdout: "", stderr: "", code: 0, timedOut: false };
    },
    async readFile() {
      return null;
    },
    async writeFile() {},
    async readFileBytes() {
      return null;
    },
    async writeFileBytes() {},
    async listDir() {
      return [];
    },
    async removeDir() {},
    async teardown() {},
    async destroyScope(id) {
      if (failDestroy) throw new Error("provider offline");
      destroyed.push(id);
    },
    async computerStatus() {
      return { machine: "running", guestResponsive: true };
    },
    async restartComputer() {},
    async startProcess() {
      throw new Error("not used");
    },
    async readProcess(_handle, processId) {
      return { chunks: "", cursor: 0, status: { state: "exited", code: 0 }, processId };
    },
    async writeStdin() {},
    async signalProcess() {},
    async listProcesses() {
      return [];
    },
  };
  const canRead = createCanReadScope({ managedGroups: projects });
  const canWrite = createCanWriteScope({ managedGroups: projects });
  const canManage = async (actor: string, target: string) =>
    target === scope ? projects.canManage(projectGroupRef("p1"), actor) : target === `personal:${actor}`;
  const guard = createProjectScopeGuard(projects, lock);
  const resources = createSandboxResources({
    records,
    defaults,
    backends: { local: backend },
    defaultBackend: "local",
    lock,
    canReadScope: canRead,
    canUseScope: canWrite,
    canManageScope: canManage,
    canCleanupScope: async (actor, target) =>
      target === scope && (await projects.get("p1"))?.deletion?.actorId === actor,
    scopeIsActive: guard.active,
  });
  const sandbox = createSandboxRouter({ backends: { local: backend }, defaultBackend: "local", resources });
  const rawSkills = createSkillStore();
  const skills = guard.skills(rawSkills);
  const events: string[] = [];
  const apps = [{ id: "app1", ownerScopeId: scope, name: "published" }];
  const deps = {
    projects,
    sandboxResources: resources,
    processes,
    sandbox,
    advisoryLock: lock,
    skills,
    identity: {
      classify: (id: string) => ({ id, type: "internal" }),
      isInternal: (actor: { type: string }) => actor.type === "internal",
    },
    auditLog: { record: (event: { action: string }) => events.push(event.action) },
    sessions: { listByScope: async () => [] },
    runs: { inFlightForThread: async () => [] },
    crons: {
      list: async () => [{ id: "cron1", ownerScopeId: scope }],
      setEnabled: async (_id: string, enabled: boolean) => {
        assert.equal(enabled, false);
        events.push("cron.stop");
      },
    },
    webhooks: { list: async () => [] },
    loopStore: { list: async () => [] },
    deploy: {
      listDeployments: async () => apps,
      transferDeploymentOwner: async (id: string, target: string) => {
        const app = apps.find((app) => app.id === id)!;
        app.ownerScopeId = target;
        events.push("app.transfer");
      },
    },
    memory: { read: async () => "saved memory" },
  } as unknown as AppDeps;
  const helpers = {
    principalCanAccessCurrentScope: canRead,
    projectView: async (project) => ({
      ...project,
      scopeId: scope,
      members: project.memberIds.map((principalId) => ({ principalId, displayName: principalId })),
    }),
  } as AppHelpers;
  return {
    projects,
    scope,
    records,
    resources,
    sandbox,
    processes,
    skills,
    rawSkills,
    deps,
    guard,
    helpers,
    methods: createSandboxMethods(deps, helpers),
    destroyed,
    events,
    apps,
    fail: (value: boolean) => {
      failDestroy = value;
    },
  };
}

test("sandbox inventory respects owning scope and members cannot manage project resources", async () => {
  const f = await fixture();
  await f.resources.create("owner", f.scope, "local", "shared");
  await f.resources.create("owner", "personal:owner", "local", "personal");
  assert.deepEqual(
    (await f.methods.listSandboxes("owner", "personal:owner")).sandboxes.map((row) => row.name),
    ["personal"],
  );
  const member = await f.methods.listSandboxes("member", f.scope);
  assert.equal(member.manageable, false);
  assert.deepEqual(member.sandboxes[0]!.availableActions, ["status"]);
  await assert.rejects(f.methods.listSandboxes("member", "personal:owner"));
  await assert.rejects(f.methods.manageSandbox("member", f.scope, { action: "create", backend: "local" }));
  await assert.rejects(f.resources.create("member", f.scope, "local"));
  await assert.rejects(f.resources.restart("member", member.sandboxes[0]!.id));
  await assert.rejects(f.resources.retire("member", member.sandboxes[0]!.id));
  await f.projects.removeMember("p1", "owner", "member");
  await assert.rejects(f.methods.listSandboxes("member", f.scope));
});

test("personal retirement stops cross-context jobs, clears its default, and preserves saved data", async () => {
  const f = await fixture();
  const record = await f.resources.create("owner", "personal:owner", "local");
  await f.resources.setDefault("owner", "personal:owner", record.id);
  await f.processes.register({
    processId: "job1",
    sandboxId: record.id,
    scopeId: f.scope,
    kind: "background",
    command: "long job",
    ttlMs: 60_000,
  });
  await assert.rejects(f.methods.manageSandbox("owner", "personal:owner", { action: "retire", sandboxId: record.id }));
  await f.methods.manageSandbox("owner", "personal:owner", { action: "retire", sandboxId: record.id, confirm: true });
  assert.equal(await f.resources.resolve("personal:owner"), null);
  assert.equal((await f.processes.get("job1"))!.status, "reaped");
  assert.equal((await f.resources.get(record.id)).state, "retired");
  assert.equal(await f.deps.memory!.read("personal:owner"), "saved memory");
  assert.deepEqual(f.destroyed, [record.backingScopeId]);
  assert.equal((await f.projects.get("p1"))!.lifecycle, undefined);
});

test("project deletion is retryable, retains frozen readership, and never retires personal sandboxes", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = await fixture();
  const shared = await f.resources.create("owner", f.scope, "local");
  const personal = await f.resources.create("owner", "personal:owner", "local");
  await f.resources.setDefault("owner", f.scope, shared.id);
  await assert.rejects(f.methods.deleteProject("member", "p1"));
  f.fail(true);
  const pending = await f.methods.deleteProject("owner", "p1");
  assert.equal(pending.lifecycle, "deleting");
  assert.ok(pending.deletion?.error);
  assert.equal((await f.resources.get(shared.id)).cleanupPending, true);
  await assert.rejects(f.resources.create("owner", f.scope, "local"), /read-only/);
  assert.equal((await f.projects.addMember("p1", "owner", "outsider")).status, "forbidden");
  assert.equal(await f.projects.membership(projectGroupRef("p1"), "member"), false);
  assert.equal(await f.projects.readableMembership(projectGroupRef("p1"), "member"), true);
  assert.equal(f.apps[0]!.ownerScopeId, f.scope);
  f.fail(false);
  const archived = await f.methods.deleteProject("owner", "p1");
  assert.equal(archived.lifecycle, "archived");
  assert.equal(f.apps[0]!.ownerScopeId, "personal:owner");
  assert.equal((await f.resources.get(personal.id)).state, "ready");
  assert.equal((await f.resources.get(shared.id)).cleanupPending, false);
  assert.equal((await f.methods.projectArchive("member", "p1")).memory, "saved memory");
  await assert.rejects(f.methods.projectArchive("outsider", "p1"));
  assert.equal(await f.projects.withVersion(projectGroupRef("p1"), undefined, async () => "write"), undefined);
  const repeat = await f.methods.deleteProject("owner", "p1");
  assert.equal(repeat.lifecycle, "archived");
  assert.equal(f.events.filter((event) => event === "app.transfer").length, 1);
  assert.equal(f.events.filter((event) => event === "cron.stop").length, 1);
});

test("archived skills and memory remain readable but cannot mutate or execute through grants", async () => {
  const f = await fixture();
  const skill = await f.skills.create({
    scopeId: f.scope,
    createdBy: "owner",
    manifest: { name: "saved", description: "Saved", body: "saved skill", requiredCapabilities: [] },
  });
  await f.skills.review(skill.id, "owner", []);
  await f.skills.publish(skill.id);
  const memory = f.guard.memory({
    read: async () => "saved memory",
    recall: async () => [],
    query: async () => ["saved memory"],
    capture: async () => 1,
    edit: async () => {},
  } satisfies MemoryService);
  await f.methods.deleteProject("owner", "p1");
  assert.equal((await f.skills.get(skill.id))!.manifest.body, "saved skill");
  await assert.rejects(f.skills.delete(skill.id), /read-only/);
  await assert.rejects(f.skills.move(skill.id, "personal:owner"), /read-only/);
  assert.deepEqual(await f.skills.visibleFor(["personal:owner"], [{ id: skill.id, ownerScopeId: f.scope }]), []);
  assert.equal((await f.skills.resolve("saved", [f.scope])).skill, null);
  assert.equal(await memory.read(f.scope), "saved memory");
  assert.deepEqual(await memory.recall(f.scope), []);
  await assert.rejects(memory.capture(f.scope, ["new"], Date.now()), /read-only/);
  await assert.rejects(memory.edit!(f.scope, [{ id: "1", text: "new" }]), /read-only/);
});

test("retirement waits for admitted commands and prevents subsequent execution", async () => {
  const f = await fixture();
  const record = await f.resources.create("owner", "personal:owner", "local");
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const command = f.resources.use(record.id, async () => {
    started.resolve();
    await finish.promise;
  });
  await started.promise;
  let retired = false;
  const retiring = f.methods
    .manageSandbox("owner", "personal:owner", { action: "retire", sandboxId: record.id, confirm: true })
    .then(() => {
      retired = true;
    });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retired, false);
  finish.resolve();
  await Promise.all([command, retiring]);
  await assert.rejects(
    f.resources.use(record.id, async () => "new command"),
    /retired/,
  );
});

test("retiring a second sandbox does not stop legacy work on the selected default", async () => {
  const f = await fixture();
  const first = await f.resources.create("owner", "personal:owner", "local", "first");
  const second = await f.resources.create("owner", "personal:owner", "local", "second");
  await f.resources.setDefault("owner", "personal:owner", first.id);
  await f.processes.register({
    sandboxId: first.id,
    processId: "legacy",
    scopeId: "personal:owner",
    kind: "background",
    command: "legacy job",
    ttlMs: 60_000,
  });
  await f.methods.manageSandbox("owner", "personal:owner", { action: "retire", sandboxId: second.id, confirm: true });
  assert.equal((await f.processes.get("legacy"))!.status, "running");
  assert.equal((await f.resources.resolve("personal:owner"))!.id, first.id);
});

test("a new core service resumes persisted deletion without another user request", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = await fixture();
  const record = await f.resources.create("owner", f.scope, "local");
  f.fail(true);
  await f.methods.deleteProject("owner", "p1");
  assert.equal((await f.projects.get("p1"))!.lifecycle, "deleting");
  f.fail(false);
  const recovered = createSandboxMethods(f.deps, f.helpers);
  assert.equal(await recovered.resumeProjectDeletions(), 1);
  assert.equal((await f.projects.get("p1"))!.lifecycle, "archived");
  assert.equal((await f.resources.get(record.id)).cleanupPending, false);
});

test("published app dependencies block deletion before changing project access", async () => {
  const f = await fixture();
  f.deps.deploy.projectDeletionBlockers = async () => [
    { appId: "app1", name: "published", reason: "Move the project connection first." },
  ];
  const preview = await f.methods.projectDeletionPreview("owner", "p1");
  assert.equal(preview.blockers[0]!.name, "published");
  await assert.rejects(f.methods.deleteProject("owner", "p1"), /Move the project connection/);
  assert.equal((await f.projects.get("p1"))!.lifecycle, undefined);
  assert.equal(await f.projects.membership(projectGroupRef("p1"), "member"), true);
  assert.equal(f.apps[0]!.ownerScopeId, f.scope);
});

test("user inventory never returns provider diagnostic secrets", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = await fixture();
  const record = await f.resources.create("owner", f.scope, "local");
  await f.records.put(record.id, { ...record, error: "Bearer secret-provider-token" });
  const inventory = await f.methods.listSandboxes("member", f.scope);
  assert.ok(inventory.sandboxes[0]!.error);
  assert.equal(JSON.stringify(inventory).includes("secret-provider-token"), false);
});

test("authorized deletion recovery still completes after the owner is offboarded", async (t) => {
  t.mock.method(console, "error", () => {});
  const f = await fixture();
  await f.resources.create("owner", f.scope, "local");
  f.fail(true);
  await f.methods.deleteProject("owner", "p1");
  f.deps.identity.isInternal = () => false;
  await assert.rejects(f.methods.deleteProject("owner", "p1"), /active/);
  f.fail(false);
  await createSandboxMethods(f.deps, f.helpers).resumeProjectDeletions();
  assert.equal((await f.projects.get("p1"))!.lifecycle, "archived");
});

test("skill updates and ownership moves serialize before project admission changes", async (t) => {
  const f = await fixture();
  const skill = await f.skills.create({
    scopeId: "personal:owner",
    createdBy: "owner",
    manifest: { name: "movable", description: "Saved", body: "old", requiredCapabilities: [] },
  });
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const get = f.rawSkills.get.bind(f.rawSkills);
  let delay = true;
  t.mock.method(f.rawSkills, "get", async (id: string) => {
    const snapshot = await get(id);
    if (delay && id === skill.id) {
      delay = false;
      entered.resolve();
      await release.promise;
    }
    return snapshot;
  });
  const updating = f.skills.update(skill.id, { ...skill.manifest, body: "updated" });
  await entered.promise;
  const moving = f.skills.move(skill.id, f.scope);
  await f.projects.beginDeletion("p1", "owner");
  release.resolve();
  await updating;
  await assert.rejects(moving, /read-only/);
  assert.equal((await f.skills.get(skill.id))!.scopeId, "personal:owner");
});
