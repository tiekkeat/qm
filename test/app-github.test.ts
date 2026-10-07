import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAppGitHubService,
  outgoingChanges,
  exportablePath,
  type AppRepositoryLink,
  type AppGitHubOperation,
} from "../src/deploy/app-github.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createMemoryAdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import type { ConnectorTokenStore } from "../src/credentials/keychain.ts";
import type { GitHubFile, GitHubIdentity, GitHubPullRequest } from "../src/deploy/github-client.ts";
import { projectScopeId } from "../src/projects/project-store.ts";
import { scopeId } from "../src/types.ts";

function fakeGitHub() {
  const files = new Map<string, Buffer>();
  const trees = new Map<string, GitHubFile[]>();
  const commits = new Map<string, string>();
  const heads = new Map<string, string>();
  const repos = new Map<
    string,
    { id: number; full_name: string; private: boolean; default_branch: string; description: string | null }
  >();
  const pulls: GitHubPullRequest[] = [];
  const calls: Array<{ method: string; path: string; actor: string; body: Record<string, unknown> }> = [];
  let failPr = false,
    push = true,
    admin = true,
    revoked = false;
  let failCommit = false;
  let counter = 0;
  const sha = () => createHash("sha1").update(String(++counter)).digest("hex");
  const blob = (data: string | Buffer) => {
    const bytes = Buffer.from(data);
    const id = createHash("sha1")
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest("hex");
    files.set(id, bytes);
    return id;
  };
  const commit = (tree: GitHubFile[]) => {
    const treeSha = sha(),
      commitSha = sha();
    trees.set(treeSha, tree);
    commits.set(commitSha, treeSha);
    return commitSha;
  };
  const addRepo = (name: string, tree: GitHubFile[]) => {
    repos.set(name, { id: ++counter, full_name: name, private: true, default_branch: "main", description: null });
    const id = commit(tree);
    heads.set(`${name}:main`, id);
    return id;
  };
  const transport = (async (url: string | URL | Request, init: RequestInit) => {
    const u = new URL(String(url)),
      path = u.pathname,
      method = init.method ?? "GET";
    const actor = new Headers(init.headers).get("authorization")!.slice(7);
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ method, path, actor, body });
    const response = (value: unknown, status = 200) =>
      new Response(status === 204 ? null : JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (revoked) return response({}, 401);
    const identity = { id: actor === "owner" ? 100 : 200, login: actor === "owner" ? "owner-gh" : "contributor-gh" };
    if (path === "/user") return response(identity);
    if (path.startsWith("/users/")) return response({ id: 200, login: "contributor-gh" });
    if (path === "/user/repos") {
      const name = `owner-gh/${body.name}`;
      addRepo(name, [{ path: "README.md", sha: blob("initial"), mode: "100644", type: "blob" }]);
      const repo = repos.get(name)!;
      repo.description = String(body.description);
      return response(repo, 201);
    }
    const parts = path.split("/");
    const name = `${parts[2]}/${parts[3]}`;
    const repo = repos.get(name);
    if (!repo) return response({}, 404);
    const tail = parts.slice(4).join("/");
    if (!tail)
      return response({ ...repo, permissions: { push: actor === "owner" || push, admin: actor === "owner" && admin } });
    if (tail.startsWith("git/ref/heads/"))
      return heads.has(`${name}:${decodeURIComponent(tail.slice(14))}`)
        ? response({ object: { sha: heads.get(`${name}:${decodeURIComponent(tail.slice(14))}`) } })
        : response({}, 404);
    if (tail.startsWith("git/commits/") && method === "GET")
      return response({ tree: { sha: commits.get(tail.slice(12)) } });
    if (tail.startsWith("git/trees/") && method === "GET")
      return response({ tree: trees.get(tail.slice(10)), truncated: false });
    if (tail === "git/blobs" && method === "POST")
      return response({ sha: blob(Buffer.from(String(body.content), "base64")) }, 201);
    if (tail.startsWith("git/blobs/") && method === "GET") {
      const data = files.get(tail.slice(10))!;
      return response({ encoding: "base64", size: data.length, content: data.toString("base64") });
    }
    if (tail === "git/trees" && method === "POST") {
      const tree = new Map((trees.get(String(body.base_tree)) ?? []).map((f) => [f.path, f]));
      for (const f of body.tree as GitHubFile[]) {
        if (f.sha === null) tree.delete(f.path);
        else tree.set(f.path, f);
      }
      const id = sha();
      trees.set(id, [...tree.values()]);
      return response({ sha: id }, 201);
    }
    if (tail === "git/commits" && method === "POST") {
      if (failCommit) {
        failCommit = false;
        return response({}, 503);
      }
      const id = sha();
      commits.set(id, String(body.tree));
      return response({ sha: id }, 201);
    }
    if (tail.startsWith("git/refs/heads/") && method === "PATCH") {
      assert.equal(body.force, false);
      heads.set(`${name}:${decodeURIComponent(tail.slice(15))}`, String(body.sha));
      return response({});
    }
    if (tail === "git/refs" && method === "POST") {
      const key = `${name}:${String(body.ref).slice(11)}`;
      if (heads.has(key)) return response({}, 422);
      heads.set(key, String(body.sha));
      return response({}, 201);
    }
    if (tail === "pulls" && method === "GET")
      return response(
        pulls.filter(
          (p) =>
            p.state === "open" &&
            `${name.split("/")[0]}:${p.head.ref}` === u.searchParams.get("head") &&
            p.base.ref === u.searchParams.get("base"),
        ),
      );
    if (tail === "pulls" && method === "POST") {
      if (failPr) {
        failPr = false;
        return response({}, 503);
      }
      const pr: GitHubPullRequest = {
        number: pulls.length + 1,
        html_url: `https://github.com/${name}/pull/1`,
        state: "open",
        merged_at: null,
        merge_commit_sha: null,
        user: identity,
        head: { ref: String(body.head), sha: heads.get(`${name}:${body.head}`)! },
        base: { ref: String(body.base), sha: heads.get(`${name}:${body.base}`)! },
      };
      pulls.push(pr);
      return response(pr, 201);
    }
    if (tail.startsWith("pulls/")) {
      const pr = pulls[Number(tail.slice(6)) - 1];
      if (new Headers(init.headers).get("x-github-api-version") === "2026-03-10") {
        const { merge_commit_sha, ...withoutMergeCommit } = pr!;
        void merge_commit_sha;
        return response(withoutMergeCommit);
      }
      return response(pr);
    }
    if (tail.endsWith("/permission")) return response({ permission: "none" });
    if (tail.startsWith("collaborators/") && method === "PUT") return response({ id: 123 }, 201);
    if (method === "DELETE") return response(null, 204);
    throw new Error(`Unexpected GitHub request ${method} ${path}`);
  }) as typeof fetch;
  return {
    transport,
    blob,
    commit,
    addRepo,
    heads,
    trees,
    commits,
    calls,
    pulls,
    set failCommit(value: boolean) {
      failCommit = value;
    },
    set failPr(value: boolean) {
      failPr = value;
    },
    set push(value: boolean) {
      push = value;
    },
    set admin(value: boolean) {
      admin = value;
    },
    set revoked(value: boolean) {
      revoked = value;
    },
  };
}

async function fixture(t: import("node:test").TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "qm-collaboration-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createDeployStore({ git: { repoRoot: join(dir, "git") } });
  const lock = createMemoryAdvisoryLock();
  let failDeploy = false,
    contributorAccess = true;
  const deploy = createDeployService({
    deployStore: store,
    provider: {
      profile: { managedScaleToZero: false },
      apply: async () => {
        if (failDeploy) throw new Error("runtime failed");
        return { host: "localhost", port: 9000 };
      },
      destroy: async () => {},
    },
    deployDir: join(dir, "snapshots"),
    advisoryLock: lock,
    acl: createAclStore(),
    auditLog: { record() {}, events: async () => [], tail: async () => [] },
    canWriteScope: async (actor) => actor === "owner" || (actor === "contributor" && contributorAccess),
  });
  const app = await deploy.deploy({
    ownerScopeId: scopeId("personal", "owner"),
    createdBy: "owner",
    createdInScope: projectScopeId("p"),
    name: "sample",
    entrypoint: "node app.js",
    title: "Launch sample",
    description: "First usable app",
    commitMessage: "Launch sample app",
    files: [
      { path: "app.js", data: "first" },
      { path: ".env", data: "SECRET=private" },
      { path: "data/db.sqlite", data: "private data" },
    ],
  });
  await deploy.shareDeployment(app.id, scopeId("personal", "contributor"), "write", { createdBy: "owner" });
  const gh = fakeGitHub();
  const links = createMemoryMap<AppRepositoryLink>();
  const operations = createMemoryMap<AppGitHubOperation>();
  const deps = {
    store,
    deploy,
    lock,
    links,
    operations,
    identities: createMemoryMap<GitHubIdentity & { verifiedAt: number }>(),
    tokens: {
      connectorDerivedAuth: async (_host: string, actor: string) => ({ accessToken: actor }),
    } as ConnectorTokenStore,
    fetch: gh.transport,
    canRead: async (_app: unknown, actor: string) =>
      actor === "owner" || (actor === "contributor" && contributorAccess),
    canConfigure: async (_app: unknown, actor: string) => actor === "owner",
  };
  const service = createAppGitHubService(deps);
  const create = () =>
    service.execute(app.id, "owner", "create", {
      operationId: "create-repo-1",
      name: "sample",
      version: 1,
      confirmed: true,
    });
  return {
    store,
    deploy,
    app,
    gh,
    service,
    links,
    operations,
    deps,
    create,
    set failDeploy(value: boolean) {
      failDeploy = value;
    },
    set contributorAccess(value: boolean) {
      contributorAccess = value;
    },
  };
}

test("owner creation exports reviewed release privately and preserves QM independently", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.service.execute(f.app.id, "owner", "create", { operationId: "unconfirmed", name: "sample" }),
    /Confirm/,
  );
  await f.create();
  await f.create();
  assert.equal(f.gh.calls.filter((c) => c.path === "/user/repos").length, 1);
  const link = (await f.links.get(f.app.id))!;
  const tree = f.gh.trees.get(f.gh.commits.get(link.baselineSha)!)!;
  assert.deepEqual(
    tree.map((f) => f.path),
    ["app.js"],
  );
  assert.equal((await f.store.get(f.app.id))!.appliedVersion, 1);
  assert.equal(
    f.gh.calls.find((c) => c.path.endsWith("git/commits") && c.method === "POST")!.body.message,
    "Launch sample app",
  );
});

test("contributor submits with their own token, retries PR failure without another commit, and imports actual squash SHA", async (t) => {
  const f = await fixture(t);
  await f.create();
  const updated = await f.deploy.deployOrUpdate({
    ownerScopeId: scopeId("personal", "contributor"),
    createdBy: "contributor",
    createdInScope: projectScopeId("p"),
    name: "sample",
    entrypoint: "node app.js",
    files: [{ path: "app.js", data: "second" }],
    title: "Add search",
    description: "Search published immediately",
    commitMessage: "Add app search",
  });
  assert.equal(updated.versions[1]!.publisher, "contributor");
  assert.equal(updated.appliedVersion, 2);
  const preview = (await f.service.execute(f.app.id, "contributor", "preview", {
    branch: "feature/search",
    version: 2,
  })) as { expectedSha: string; changes: Array<{ after: string }> };
  assert.equal(preview.changes[0]!.after, "second");
  const input = {
    operationId: "submit-search",
    branch: "feature/search",
    version: 2,
    expectedSha: preview.expectedSha,
    confirmed: true,
  };
  f.gh.failPr = true;
  await assert.rejects(f.service.execute(f.app.id, "contributor", "submit", input), /503/);
  const commitCount = f.gh.calls.filter((c) => c.path.endsWith("git/commits") && c.method === "POST").length;
  await f.service.execute(f.app.id, "contributor", "submit", input);
  assert.equal(f.gh.calls.filter((c) => c.path.endsWith("git/commits") && c.method === "POST").length, commitCount);
  assert.equal(f.gh.pulls[0]!.user.login, "contributor-gh");
  assert.equal(
    f.gh.calls.filter((c) => c.path.includes("pulls")).every((c) => c.actor === "contributor"),
    true,
  );
  const pr = f.gh.pulls[0]!;
  const squash = f.gh.commit([{ path: "app.js", sha: f.gh.blob("merged"), mode: "100644", type: "blob" }]);
  pr.merged_at = new Date().toISOString();
  pr.merge_commit_sha = squash;
  pr.state = "closed";
  const submissionId = `${f.app.id}:submit-search`;
  const importedPreview = (await f.service.execute(f.app.id, "owner", "import-preview", { submissionId })) as {
    expectedSha: string;
    expectedVersion: number;
  };
  assert.equal((await f.store.get(f.app.id))!.appliedVersion, 2);
  await f.service.execute(f.app.id, "owner", "import", {
    operationId: "import-search",
    submissionId,
    expectedSha: importedPreview.expectedSha,
    expectedVersion: importedPreview.expectedVersion,
    confirmed: true,
  });
  assert.equal((await f.store.get(f.app.id))!.versions[2]!.sourceSha, squash);
  assert.equal((await f.store.get(f.app.id))!.appliedVersion, 3);
});

test("existing shared repository linking never changes base and preserves unrelated files", async (t) => {
  const f = await fixture(t);
  const base = f.gh.addRepo("org/shared", [
    { path: "other/index.js", sha: f.gh.blob("other app"), mode: "100644", type: "blob" },
    { path: "apps/sample/app.js", sha: f.gh.blob("remote first"), mode: "100644", type: "blob" },
  ]);
  const compare = (await f.service.execute(f.app.id, "owner", "compare", {
    repository: "org/shared",
    directory: "apps/sample",
    version: 1,
  })) as { expectedSha: string; expectedVersion: number };
  await f.service.execute(f.app.id, "owner", "link", {
    operationId: "link-shared",
    repository: "org/shared",
    directory: "apps/sample",
    version: 1,
    choice: "export",
    expectedSha: compare.expectedSha,
    expectedVersion: compare.expectedVersion,
    confirmed: true,
  });
  assert.equal(f.gh.heads.get("org/shared:main"), base);
  const preview = (await f.service.execute(f.app.id, "contributor", "preview", {
    branch: "feature/app",
    version: 1,
  })) as { expectedSha: string };
  await f.service.execute(f.app.id, "contributor", "submit", {
    operationId: "export-shared",
    branch: "feature/app",
    version: 1,
    expectedSha: preview.expectedSha,
    confirmed: true,
    createPr: false,
  });
  const head = f.gh.heads.get("org/shared:feature/app")!;
  assert.deepEqual(
    f.gh.trees
      .get(f.gh.commits.get(head)!)!
      .map((f) => f.path)
      .sort(),
    ["apps/sample/app.js", "other/index.js"],
  );
  assert.equal(f.gh.heads.get("org/shared:main"), base);
});

test("access checks reject missing write access, owner setup by contributor, revoked token, and removed QM membership", async (t) => {
  const f = await fixture(t);
  await f.create();
  await assert.rejects(
    f.service.execute(f.app.id, "contributor", "create", { operationId: "bad-setup", name: "x", confirmed: true }),
    /Only the project/,
  );
  await assert.rejects(
    f.service.execute(f.app.id, "contributor", "submit", {
      operationId: "base-submit",
      branch: "main",
      version: 1,
      confirmed: true,
    }),
    /base branch/,
  );
  f.gh.push = false;
  await assert.rejects(
    f.service.execute(f.app.id, "contributor", "submit", {
      operationId: "no-write",
      branch: "feature/x",
      version: 1,
      confirmed: true,
    }),
    /write access/,
  );
  f.gh.push = true;
  f.gh.revoked = true;
  await assert.rejects(f.service.execute(f.app.id, "contributor", "access", {}), /Reconnect/);
  f.gh.revoked = false;
  f.contributorAccess = false;
  await assert.rejects(f.service.inspect(f.app.id, "contributor"), /not found/);
});

test("rollback records correct actor and failure while preserving live badge and newer releases", async (t) => {
  const f = await fixture(t);
  await f.deploy.redeploy(f.app.id, {
    entrypoint: "node app.js",
    files: [{ path: "app.js", data: "second" }],
    publisher: "contributor",
  });
  f.failDeploy = true;
  await assert.rejects(f.deploy.rollbackDeployment(f.app.id, 1, { actorId: "contributor" }), /runtime failed/);
  const failed = (await f.store.get(f.app.id))!;
  assert.equal(failed.appliedVersion, 2);
  assert.equal(failed.versions.length, 2);
  assert.equal(failed.events!.at(-1)!.actor, "contributor");
  assert.equal(failed.events!.at(-1)!.outcome, "failed");
  f.failDeploy = false;
  await f.deploy.rollbackDeployment(f.app.id, 1, { actorId: "owner" });
  const next = await f.deploy.redeploy(f.app.id, {
    entrypoint: "node app.js",
    files: [{ path: "app.js", data: "third" }],
  });
  assert.equal(next.currentVersion, 3);
  assert.equal(next.versions[2]!.parentCommit, next.versions[0]!.commit);
});

test("three-way outgoing changes preserve unrelated changes and stop conflicting changes", () => {
  const file = (path: string, sha: string): GitHubFile => ({ path, sha, mode: "100644", type: "blob" });
  assert.deepEqual(
    outgoingChanges(
      [file("a", "1"), file("b", "1")],
      [file("a", "2"), file("b", "1")],
      [file("a", "1"), file("b", "3")],
    ).map((f) => f.path),
    ["a"],
  );
  assert.throws(() => outgoingChanges([file("a", "1")], [file("a", "2")], [file("a", "3")]), /Conflict/);
  for (const path of [".env", ".env.production", "data/app.db", "credentials.json"])
    assert.equal(exportablePath(path), false);
  assert.equal(exportablePath(".env.example"), true);
});

test("repository initialization resumes after upload failure without creating another repository", async (t) => {
  const f = await fixture(t);
  f.gh.failCommit = true;
  await assert.rejects(f.create(), /503/);
  const pending = (await f.service.inspect(f.app.id, "owner")).operations.find((o) => o.id.endsWith("create-repo-1"))!;
  assert.equal(pending.input!.name, "sample");
  const restarted = createAppGitHubService(f.deps);
  await restarted.execute(f.app.id, "owner", "create", {
    operationId: "create-repo-1",
    name: "sample",
    version: 1,
    confirmed: true,
  });
  assert.equal(f.gh.calls.filter((c) => c.path === "/user/repos").length, 1);
  assert.equal((await f.links.get(f.app.id))!.baselineVersion, 1);
  await assert.rejects(
    f.service.execute(f.app.id, "owner", "create", {
      operationId: "create-repo-1",
      name: "different",
      version: 1,
      confirmed: true,
    }),
    /different request/,
  );
});

test("invitations require confirmation of verified username, owner administration and record only QM-granted access", async (t) => {
  const f = await fixture(t);
  await f.create();
  const verified = (await f.service.execute(f.app.id, "owner", "contributor-access", {
    principalId: "contributor",
  })) as { identity: GitHubIdentity };
  assert.equal(verified.identity.login, "contributor-gh");
  const input = {
    operationId: "invite-user-a",
    principalId: "contributor",
    expectedGitHubUserId: verified.identity.id,
    confirmed: true,
  };
  await f.service.execute(f.app.id, "owner", "invite", input);
  const invitation = (await f.operations.get(`${f.app.id}:invite-user-a`))!;
  assert.equal(invitation.invitation!.username, "contributor-gh");
  assert.equal(f.gh.calls.find((c) => c.method === "PUT")!.actor, "owner");
  f.gh.push = false;
  assert.equal((await f.service.inspect(f.app.id, "contributor")).githubAccess, "Invitation pending");
  f.gh.admin = false;
  await assert.rejects(
    f.service.execute(f.app.id, "owner", "remove-access", {
      operationId: "remove-user-a",
      invitationId: invitation.id,
      confirmed: true,
    }),
    /administration/,
  );
  f.gh.admin = true;
  await f.service.execute(f.app.id, "owner", "remove-access", {
    operationId: "remove-user-a",
    invitationId: invitation.id,
    confirmed: true,
  });
  assert.ok((await f.operations.get(invitation.id))!.invitation!.removedAt);
});

test("destination changes after review stop submission without updating refs", async (t) => {
  const f = await fixture(t);
  await f.create();
  const link = (await f.links.get(f.app.id))!;
  f.gh.heads.set(`${link.repository}:feature/active`, link.baselineSha);
  await f.deploy.redeploy(f.app.id, {
    entrypoint: "node app.js",
    files: [{ path: "app.js", data: "update" }],
    publisher: "contributor",
  });
  const preview = (await f.service.execute(f.app.id, "contributor", "preview", {
    branch: "feature/active",
    existingBranch: true,
    version: 2,
  })) as { expectedSha: string };
  const concurrent = f.gh.commit([
    { path: "app.js", sha: f.gh.blob("first"), mode: "100644", type: "blob" },
    { path: "unrelated", sha: f.gh.blob("new"), mode: "100644", type: "blob" },
  ]);
  f.gh.heads.set(`${link.repository}:feature/active`, concurrent);
  await assert.rejects(
    f.service.execute(f.app.id, "contributor", "submit", {
      operationId: "concurrent-submit",
      branch: "feature/active",
      existingBranch: true,
      version: 2,
      expectedSha: preview.expectedSha,
      confirmed: true,
    }),
    /Review the outgoing/,
  );
  assert.equal(f.gh.heads.get(`${link.repository}:feature/active`), concurrent);
});

test("merged import retries reuse a failed release and require review when QM changed", async (t) => {
  const f = await fixture(t);
  await f.create();
  const link = (await f.links.get(f.app.id))!;
  const merge = f.gh.commit([{ path: "app.js", sha: f.gh.blob("merged"), mode: "100644", type: "blob" }]);
  const pr: GitHubPullRequest = {
    number: 1,
    html_url: "https://github.com/owner-gh/sample/pull/1",
    state: "closed",
    merged_at: new Date().toISOString(),
    merge_commit_sha: merge,
    user: { id: 200, login: "contributor-gh" },
    head: { ref: "feature/x", sha: merge },
    base: { ref: "main", sha: link.baselineSha },
  };
  f.gh.pulls.push(pr);
  await f.operations.put("merged-submission", {
    id: "merged-submission",
    appId: f.app.id,
    actor: "contributor",
    action: "submit",
    at: Date.now(),
    requestHash: "x",
    repository: link.repository,
    repositoryId: link.repositoryId,
    release: 1,
    pr,
  });
  await f.deploy.redeploy(f.app.id, {
    entrypoint: "node app.js",
    files: [{ path: "app.js", data: "newer" }],
    publisher: "owner",
  });
  const preview = (await f.service.execute(f.app.id, "owner", "import-preview", {
    submissionId: "merged-submission",
  })) as { replacesNewerChanges: boolean; expectedSha: string; expectedVersion: number };
  assert.equal(preview.replacesNewerChanges, true);
  const input = {
    operationId: "retry-import",
    submissionId: "merged-submission",
    expectedSha: preview.expectedSha,
    expectedVersion: preview.expectedVersion,
    confirmed: true,
  };
  f.failDeploy = true;
  await assert.rejects(f.service.execute(f.app.id, "owner", "import", input), /runtime failed/);
  assert.equal((await f.store.get(f.app.id))!.versions.length, 3);
  assert.equal((await f.store.get(f.app.id))!.appliedVersion, 2);
  f.failDeploy = false;
  await createAppGitHubService(f.deps).execute(f.app.id, "owner", "import", input);
  assert.equal((await f.store.get(f.app.id))!.versions.length, 3);
  assert.equal((await f.store.get(f.app.id))!.appliedVersion, 3);
});

test("linking import resumes a failed deployment without duplicating releases or changing the base", async (t) => {
  const f = await fixture(t);
  const sha = f.gh.addRepo("org/shared", [
    { path: "apps/sample/app.js", sha: f.gh.blob("remote import"), mode: "100644", type: "blob" },
    { path: "other/index.js", sha: f.gh.blob("unrelated"), mode: "100644", type: "blob" },
  ]);
  const preview = (await f.service.execute(f.app.id, "owner", "compare", {
    repository: "org/shared",
    directory: "apps/sample",
    version: 1,
  })) as { expectedSha: string; expectedVersion: number };
  const input = {
    operationId: "retry-link-import",
    repository: "org/shared",
    directory: "apps/sample",
    version: 1,
    choice: "import" as const,
    expectedSha: preview.expectedSha,
    expectedVersion: preview.expectedVersion,
    confirmed: true,
  };
  f.failDeploy = true;
  await assert.rejects(f.service.execute(f.app.id, "owner", "link", input), /runtime failed/);
  assert.equal((await f.store.get(f.app.id))!.versions.length, 2);
  assert.equal((await f.store.get(f.app.id))!.appliedVersion, 1);
  f.failDeploy = false;
  await createAppGitHubService(f.deps).execute(f.app.id, "owner", "link", input);
  assert.equal((await f.store.get(f.app.id))!.versions.length, 2);
  assert.equal((await f.store.get(f.app.id))!.appliedVersion, 2);
  assert.equal((await f.links.get(f.app.id))!.baselineSha, sha);
  assert.equal(f.gh.heads.get("org/shared:main"), sha);
  assert.equal(
    (await f.store.filesOf(f.app.id, 2))!.some((file) => file.path.startsWith("other/")),
    false,
  );
});

test("release corrections preserve commit metadata and identical-source releases retain their actual author and message", async (t) => {
  const f = await fixture(t);
  const first = (await f.store.get(f.app.id))!.versions[0]!;
  await f.store.editRelease(f.app.id, 1, { title: "Corrected title", description: "Corrected description" });
  const corrected = (await f.store.get(f.app.id))!.versions[0]!;
  assert.equal(corrected.commit, first.commit);
  assert.equal(corrected.commitMessage, "Launch sample app");
  const next = await f.deploy.redeploy(f.app.id, {
    entrypoint: "node app.js",
    publisher: "contributor",
    title: "Improve release configuration",
    commitMessage: "Keep app source and improve launch settings",
    files: (await f.store.filesOf(f.app.id, 1))!,
  });
  assert.notEqual(next.versions[1]!.commit, first.commit);
  assert.equal(next.versions[1]!.publisher, "contributor");
});

test("rollback retries are durable and do not undo a later publish", async (t) => {
  const f = await fixture(t);
  await f.deploy.redeploy(f.app.id, {
    entrypoint: "node app.js",
    files: [{ path: "app.js", data: "second" }],
    publisher: "contributor",
    alwaysOn: true,
  });
  const input = { actorId: "owner", operationId: "restore-first" };
  await f.deploy.rollbackDeployment(f.app.id, 1, input);
  assert.equal((await f.store.get(f.app.id))!.alwaysOn, false);
  await f.deploy.redeploy(f.app.id, {
    entrypoint: "node app.js",
    files: [{ path: "app.js", data: "third" }],
    publisher: "contributor",
  });
  await f.deploy.rollbackDeployment(f.app.id, 1, input);
  assert.equal((await f.store.get(f.app.id))!.appliedVersion, 3);
  assert.equal((await f.store.get(f.app.id))!.events!.filter((e) => e.id === "rollback:restore-first").length, 1);
});
