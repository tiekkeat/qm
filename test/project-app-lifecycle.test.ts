import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createProjectStore, projectGroupRef, projectScopeId } from "../src/projects/project-store.ts";
import { createProjectScopeGuard } from "../src/projects/project-scope-guard.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import {
  createCanManageScope,
  createCanWriteScope,
  createManagesArtifactHome,
} from "../src/resolution/scope-membership.ts";
import { mintCapabilityToken } from "../src/auth/capability-token.ts";

async function fixture() {
  const lock = createMemoryAdvisoryLock();
  const projects = createProjectStore(undefined, { id: () => "p1", advisoryLock: lock });
  await projects.create({ name: "Launch", ownerId: "owner" });
  const scope = projectScopeId("p1");
  const guard = createProjectScopeGuard(projects, lock);
  const membership = { managedGroups: projects };
  const store = createDeployStore();
  const deploy = createDeployService({
    deployStore: store,
    deployDir: mkdtempSync(join(tmpdir(), "project-app-")),
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => ({ host: "127.0.0.1", port: 9000 }),
      destroy: async () => {},
    },
    acl: createAclStore(),
    auditLog: createAuditLog(),
    advisoryLock: lock,
    withScopeWrite: guard.write,
    scopeIsActive: guard.active,
    canWriteScope: createCanWriteScope(membership),
    managesArtifactHome: createManagesArtifactHome(membership, createCanManageScope(membership)),
    canTransferHome: async (source, actor) =>
      source === scope &&
      (await projects.get("p1"))?.lifecycle === "deleting" &&
      (await projects.canManage(projectGroupRef("p1"), actor)),
  });
  return { projects, scope, deploy, store };
}

test("app dependencies detect plain and compressed project credentials before deletion", async () => {
  const f = await fixture();
  const plain = await mintCapabilityToken(
    { actorId: "owner", scopeId: f.scope, exp: Date.now() + 60_000 },
    "test-secret",
    false,
  );
  const compressed = await mintCapabilityToken(
    { actorId: "owner", scopeId: f.scope, exp: Date.now() + 60_000 },
    "test-secret",
    true,
  );
  for (const [name, token] of [
    ["plain", plain],
    ["compressed", compressed],
  ] as const) {
    await f.deploy.deploy({
      ownerScopeId: f.scope,
      createdInScope: f.scope,
      createdBy: "owner",
      name,
      entrypoint: "node app.js",
      files: [{ path: "app.js", data: "console.log('app')" }],
      env: { AGENT_TOKEN: token },
    });
  }
  await f.deploy.deploy({
    ownerScopeId: f.scope,
    createdInScope: f.scope,
    createdBy: "owner",
    name: "static",
    entrypoint: "node app.js",
    files: [{ path: "app.js", data: "console.log('static')" }],
  });
  const blockers = await f.deploy.projectDeletionBlockers(f.scope, []);
  assert.deepEqual(blockers.map((row) => row.name).sort(), ["compressed", "plain"]);
});

test("dependency preflight inspects the serving revision after a failed replacement", async () => {
  const f = await fixture();
  const app = await f.deploy.deploy({
    ownerScopeId: f.scope,
    createdBy: "owner",
    name: "serving",
    entrypoint: "node app.js",
    files: [{ path: "app.js", data: "console.log('app')" }],
    env: { SANDBOX_ID: "project-machine" },
  });
  const failed = await f.store.addVersion(app.id, {
    entrypoint: "node app.js",
    snapshotDir: app.versions[0]!.snapshotDir,
    files: [{ path: "app.js", data: "console.log('safe replacement')" }],
  });
  await f.store.setDeployFailure(app.id, failed.version);
  assert.equal((await f.store.get(app.id))!.appliedVersion, 1);
  assert.deepEqual(
    (await f.deploy.projectDeletionBlockers(f.scope, ["project-machine"])).map((row) => row.appId),
    [app.id],
  );
});

test("ownership cleanup permits transfer out of deleting project and rejects transfer into archives", async () => {
  const f = await fixture();
  const shared = await f.deploy.deploy({
    ownerScopeId: f.scope,
    createdInScope: f.scope,
    createdBy: "owner",
    name: "shared",
    entrypoint: "node app.js",
    files: [],
  });
  const personal = await f.deploy.deploy({
    ownerScopeId: "personal:owner",
    createdBy: "owner",
    name: "personal",
    entrypoint: "node app.js",
    files: [],
  });
  await f.projects.beginDeletion("p1", "owner");
  await assert.rejects(
    f.deploy.transferDeploymentOwner(shared.id, "personal:owner", { callerId: "owner" }),
    /read-only/,
  );
  await f.deploy.transferDeploymentOwner(shared.id, "personal:owner", { callerId: "owner", projectDeletion: true });
  assert.equal((await f.store.get(shared.id))!.ownerScopeId, "personal:owner");
  await f.projects.deletionProgress("p1", [], undefined, true);
  await assert.rejects(f.deploy.transferDeploymentOwner(personal.id, f.scope, { callerId: "owner" }), /read-only/);
  await assert.rejects(
    f.deploy.deploy({ ownerScopeId: f.scope, createdBy: "owner", name: "late", entrypoint: "node app.js", files: [] }),
    /read-only/,
  );
});

test("all publication and settings paths reject writes to a deleting project's apps", async () => {
  const f = await fixture();
  const app = await f.deploy.deploy({
    ownerScopeId: f.scope,
    createdInScope: f.scope,
    createdBy: "owner",
    name: "shared",
    entrypoint: "node app.js",
    files: [{ path: "app.js", data: "old" }],
  });
  await f.projects.beginDeletion("p1", "owner");
  await assert.rejects(
    f.deploy.deployOrUpdate({
      ownerScopeId: "personal:owner",
      createdBy: "owner",
      name: "shared",
      env: { CHANGED: "true" },
    }),
    /read-only/,
  );
  await assert.rejects(f.deploy.rollbackDeployment(app.id, 1), /read-only/);
  await assert.rejects(f.deploy.setDeploymentAlwaysOn(app.id, true), /read-only/);
  await assert.rejects(f.deploy.setDeploymentPublic(app.id, true, { createdBy: "owner" }), /read-only/);
  await assert.rejects(f.deploy.renameDeployment(app.id, "changed"), /read-only/);
  await assert.rejects(
    f.deploy.deployOrUpdate({
      ownerScopeId: "personal:owner",
      createdBy: "owner",
      name: "unused",
      renameFrom: "shared",
    }),
    /read-only/,
  );
  assert.equal((await f.store.get(app.id))!.name, "shared");
});
