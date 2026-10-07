import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresMapFactory } from "../src/persistence/durable-map.ts";
import type { AppRepositoryLink, AppGitHubOperation } from "../src/deploy/app-github.ts";
import type { GitHubIdentity } from "../src/deploy/github-client.ts";
import { createDeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import { scopeId } from "../src/types.ts";

const databaseUrl = process.env.DATABASE_URL;
test(
  "collaboration baselines, partial submissions, verified identities and rollback outcomes survive independent Postgres readers",
  { skip: databaseUrl ? false : "DATABASE_URL required" },
  async (t) => {
    const first = createPostgresMapFactory(databaseUrl!);
    const second = createPostgresMapFactory(databaseUrl!);
    t.after(async () => {
      await first.pool.close();
      await second.pool.close();
    });
    const links = first.map<AppRepositoryLink>("app_repository_links");
    const operations = first.map<AppGitHubOperation>("app_github_operations");
    const identities = first.map<GitHubIdentity & { verifiedAt: number }>("app_github_identities");
    const store = createDeployStore({ deployments: first.map<Deployment>("deployments"), pg: first.pool });
    const deployment = await store.create({
      ownerScopeId: scopeId("personal", "owner"),
      createdBy: "owner",
      entrypoint: "node app.js",
      snapshotDir: "/tmp",
      title: "Launch",
      description: "Initial app",
      commitMessage: "Launch app",
    });
    await links.put(deployment.id, {
      id: deployment.id,
      repository: "owner/sample",
      repositoryId: 123,
      base: "main",
      directory: "apps/sample/",
      configuredBy: "owner",
      baselineVersion: 1,
      baselineSha: "a".repeat(40),
      linkedAt: Date.now(),
    });
    await operations.put("partial", {
      id: "partial",
      appId: deployment.id,
      actor: "contributor",
      action: "submit",
      requestHash: "reviewed",
      at: Date.now(),
      commit: "b".repeat(40),
      branch: "feature/search",
      release: 1,
    });
    await identities.put("contributor", { id: 200, login: "verified-user", verifiedAt: Date.now() });
    await store.recordEvent(deployment.id, {
      id: "rollback:test",
      actor: "contributor",
      fromVersion: 2,
      toVersion: 1,
      at: Date.now(),
      kind: "rollback",
      outcome: "failed",
    });
    const restarted = createDeployStore({ deployments: second.map<Deployment>("deployments"), pg: second.pool });
    assert.equal(
      (await second.map<AppRepositoryLink>("app_repository_links").get(deployment.id))!.directory,
      "apps/sample/",
    );
    assert.equal(
      (await second.map<AppGitHubOperation>("app_github_operations").get("partial"))!.commit,
      "b".repeat(40),
    );
    assert.equal(
      (await second.map<GitHubIdentity>("app_github_identities").get("contributor"))!.login,
      "verified-user",
    );
    assert.equal((await restarted.get(deployment.id))!.events![0]!.outcome, "failed");
    await restarted.editRelease(deployment.id, 1, { title: "Corrected", description: "Edited text" });
    const stored = (await restarted.get(deployment.id))!.versions[0]!;
    assert.equal(stored.title, "Corrected");
    assert.equal(stored.commitMessage, "Launch app");
  },
);
