import { createHash } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { ConnectorTokenStore } from "../credentials/keychain.ts";
import type { DeployStore, Deployment } from "./deploy-store.ts";
import type { DeployService } from "./deploy-service.ts";
import { normalizeRelPath } from "./deploy-fs.ts";
import {
  createGitHubClient,
  GitHubError,
  type GitHubFile,
  type GitHubIdentity,
  type GitHubPullRequest,
  type GitHubRepository,
} from "./github-client.ts";

export interface AppRepositoryLink {
  id: string;
  repository: string;
  repositoryId: number;
  base: string;
  directory: string;
  configuredBy: string;
  baselineVersion: number;
  baselineSha: string;
  linkedAt: number;
  operationId?: string;
  unlinkedAt?: number;
}

export interface AppGitHubOperation {
  id: string;
  appId: string;
  actor: string;
  action: string;
  requestHash: string;
  at: number;
  repository?: string;
  repositoryId?: number;
  commit?: string;
  parent?: string;
  branch?: string;
  release?: number;
  pr?: GitHubPullRequest;
  invitation?: { id?: number; username: string; userId: number; granted: boolean; removedAt?: number };
  changes?: Array<{ path: string; sha: string | null; mode: string; type: "blob" }>;
  input?: CollaborationInput;
  result?: unknown;
}

export interface CollaborationInput {
  operationId?: string;
  version?: number;
  expectedVersion?: number;
  expectedSha?: string;
  repository?: string;
  name?: string;
  base?: string;
  directory?: string;
  choice?: "import" | "export";
  branch?: string;
  existingBranch?: boolean;
  message?: string;
  title?: string;
  description?: string;
  createPr?: boolean;
  confirmed?: boolean;
  principalId?: string;
  submissionId?: string;
  invitationId?: string;
  expectedGitHubUserId?: number;
}

export function collaborationInput(value: unknown): CollaborationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("An action object is required.");
  const input = value as Record<string, unknown>;
  for (const key of [
    "operationId",
    "expectedSha",
    "repository",
    "name",
    "base",
    "directory",
    "branch",
    "message",
    "title",
    "description",
    "principalId",
    "submissionId",
    "invitationId",
  ]) {
    if (input[key] !== undefined && (typeof input[key] !== "string" || (input[key] as string).length > 10000))
      throw new Error(`Invalid ${key}.`);
  }
  for (const key of ["version", "expectedVersion", "expectedGitHubUserId"]) {
    if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || Number(input[key]) < 1))
      throw new Error(`Invalid ${key}.`);
  }
  for (const key of ["existingBranch", "createPr", "confirmed"]) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error(`Invalid ${key}.`);
  }
  if (input.choice !== undefined && !["import", "export"].includes(String(input.choice)))
    throw new Error("Invalid synchronization choice.");
  const allowed = new Set([
    "operationId",
    "version",
    "expectedVersion",
    "expectedSha",
    "repository",
    "name",
    "base",
    "directory",
    "choice",
    "branch",
    "existingBranch",
    "message",
    "title",
    "description",
    "createPr",
    "confirmed",
    "principalId",
    "submissionId",
    "invitationId",
    "expectedGitHubUserId",
  ]);
  return Object.fromEntries(Object.entries(input).filter(([key]) => allowed.has(key))) as CollaborationInput;
}

export interface AppGitHubDeps {
  store: DeployStore;
  deploy: DeployService;
  links: DurableMap<AppRepositoryLink>;
  operations: DurableMap<AppGitHubOperation>;
  identities: DurableMap<GitHubIdentity & { verifiedAt: number }>;
  tokens: ConnectorTokenStore;
  lock: AdvisoryLock;
  canRead(app: Deployment, actor: string): Promise<boolean>;
  canConfigure(app: Deployment, actor: string): Promise<boolean>;
  oauthConfigured?: () => Promise<boolean>;
  fetch?: typeof fetch;
}

export function exportablePath(path: string): boolean {
  const parts = normalizeRelPath(path).split("/");
  return (
    !parts.some((part) =>
      [".git", "node_modules", "data", ".data", ".qm", ".aws", ".ssh", ".keychain"].includes(part),
    ) &&
    !parts.some(
      (part) =>
        part === ".env" ||
        (part.startsWith(".env.") && ![".env.example", ".env.sample"].includes(part)) ||
        ["credentials.json", "secrets.json"].includes(part),
    )
  );
}

function repositoryName(value: string): string {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(value)) throw new Error("Repository must be owner/name.");
  return value;
}

function branchName(value: string): string {
  if (
    !value ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\s~^:?*[\\\x00-\x1f\x7f]/.test(value) ||
    value.split("/").some((p) => !p || p.startsWith(".") || p.endsWith(".lock"))
  )
    throw new Error("Invalid Git branch name.");
  return value;
}

function directoryName(value = ""): string {
  if (!value) return "";
  const normalized = normalizeRelPath(value);
  if (normalized !== value || !exportablePath(normalized)) throw new Error("Choose a safe relative app directory.");
  return `${normalized}/`;
}

function inDirectory(files: GitHubFile[], directory: string): GitHubFile[] {
  const scoped = files
    .filter((f) => f.path.startsWith(directory))
    .map((f) => ({ ...f, path: f.path.slice(directory.length) }));
  if (scoped.some((f) => f.type !== "blob" || !["100644", "100755"].includes(f.mode)))
    throw new Error(
      "App directory contains symlinks or submodules. Choose a directory containing regular source files.",
    );
  return scoped.filter((f) => exportablePath(f.path));
}

export function outgoingChanges(
  baseline: GitHubFile[],
  target: GitHubFile[],
  destination: GitHubFile[],
): Array<{ path: string; sha: string | null; mode: string; type: "blob" }> {
  const before = new Map(baseline.map((f) => [f.path, f]));
  const after = new Map(target.map((f) => [f.path, f]));
  const remote = new Map(destination.map((f) => [f.path, f]));
  const equal = (a?: GitHubFile, b?: GitHubFile) => a?.sha === b?.sha && a?.mode === b?.mode;
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path) => {
    const old = before.get(path),
      next = after.get(path),
      current = remote.get(path);
    if (equal(old, next) || equal(next, current)) return [];
    if (!equal(old, current)) throw new Error(`Conflict in ${path}. Refresh and review the destination branch.`);
    return [{ path, sha: next?.sha ?? null, mode: next?.mode ?? old!.mode, type: "blob" as const }];
  });
}

export function createAppGitHubService(deps: AppGitHubDeps) {
  async function account(actor: string) {
    const token = await deps.tokens.connectorDerivedAuth("api.github.com", actor);
    if (!token)
      throw new GitHubError(401, "GitHub not connected. Connect or reconnect in Keychain → Linked accounts → GitHub.");
    const client = createGitHubClient(token.accessToken, deps.fetch);
    const identity = await client.identity();
    await deps.identities.put(actor, { ...identity, verifiedAt: Date.now() });
    return { client, identity };
  }
  async function appFor(id: string, actor: string, manage = false) {
    const app = (await deps.store.get(id)) ?? (await deps.store.getByName(id));
    if (!app || !(await deps.canRead(app, actor))) throw new GitHubError(404, "App not found.");
    if (manage && !(await deps.deploy.canManageDeployment(app.id, actor)))
      throw new GitHubError(403, "QM app manage access is required.");
    return app;
  }
  async function selected(app: Deployment, version = app.currentVersion) {
    const release = await deps.store.versionOf(app.id, version);
    const files = await deps.store.filesOf(app.id, version);
    const tree = await deps.store.treeOf(app.id, version);
    if (!release || !files || !tree) throw new Error("This release has no stored source snapshot.");
    return {
      release,
      files: files.filter((f) => exportablePath(f.path)),
      tree: tree.filter((f) => exportablePath(f.path)).map((f) => ({ ...f, type: "blob" })),
    };
  }
  async function reviewChanges(
    client: ReturnType<typeof createGitHubClient>,
    repo: string,
    changes: Array<{ path: string; sha: string | null }>,
    before: GitHubFile[],
    afterFiles?: Array<{ path: string; data: string | Uint8Array }>,
  ) {
    if (changes.length > 500)
      throw new Error("Too many outgoing files to review safely. Select a smaller app directory.");
    const read = async (sha?: string | null) => {
      if (!sha) return null;
      const blob = await client.request<{ content: string; size: number; encoding: string }>(
        "GET",
        `/repos/${repo}/git/blobs/${sha}`,
      );
      if (blob.size > 100_000 || blob.encoding !== "base64") return "Binary or large file";
      const bytes = Buffer.from(blob.content, "base64");
      return bytes.includes(0) ? "Binary file" : bytes.toString("utf8");
    };
    const result = [];
    for (const change of changes) {
      const file = afterFiles?.find((f) => f.path === change.path);
      const data = file ? Buffer.from(file.data) : undefined;
      let after: string | null;
      if (change.sha === null) after = null;
      else if (!data) after = await read(change.sha);
      else if (data.length > 100_000 || data.includes(0)) after = "Binary or large file";
      else after = data.toString("utf8");
      result.push({ ...change, before: await read(before.find((f) => f.path === change.path)?.sha), after });
    }
    return result;
  }
  async function activeLink(id: string) {
    const link = await deps.links.get(id);
    if (!link || link.unlinkedAt) throw new Error("Connect a repository first.");
    return link;
  }
  async function permissions(client: ReturnType<typeof createGitHubClient>, repo: string, write: boolean) {
    const repository = await client.repository(repo);
    if (write && !repository.permissions?.push)
      throw new GitHubError(403, "GitHub repository write access is required.");
    return repository;
  }
  async function writeCommit(
    client: ReturnType<typeof createGitHubClient>,
    repo: string,
    directory: string,
    parent: string,
    baseline: GitHubFile[],
    app: Deployment,
    input: CollaborationInput,
    identity: GitHubIdentity,
    operation: AppGitHubOperation,
  ) {
    const target = await selected(app, input.version);
    const destination = await client.tree(repo, parent);
    const changes = outgoingChanges(baseline, target.tree, inDirectory(destination.files, directory));
    if (!changes.length) return { sha: parent, changes };
    for (const change of changes) {
      if (change.sha === null) continue;
      const file = target.files.find((f) => f.path === change.path)!;
      const blob = await client.request<{ sha: string }>("POST", `/repos/${repo}/git/blobs`, {
        content: Buffer.from(file.data).toString("base64"),
        encoding: "base64",
      });
      if (blob.sha !== change.sha) throw new Error("Outgoing file hash changed.");
    }
    const tree = await client.request<{ sha: string }>("POST", `/repos/${repo}/git/trees`, {
      base_tree: destination.treeSha,
      tree: changes.map((f) => ({ ...f, path: `${directory}${f.path}` })),
    });
    const commit = await client.request<{ sha: string }>("POST", `/repos/${repo}/git/commits`, {
      message:
        input.message?.trim() ||
        target.release.commitMessage ||
        target.release.title ||
        `Publish version ${target.release.version}`,
      tree: tree.sha,
      parents: [parent],
      author: { name: identity.login, email: `${identity.id}+${identity.login}@users.noreply.github.com` },
    });
    operation.commit = commit.sha;
    operation.parent = parent;
    await deps.operations.put(operation.id, operation);
    return { sha: commit.sha, changes };
  }
  async function updateBranch(
    client: ReturnType<typeof createGitHubClient>,
    repo: string,
    branch: string,
    expected: string | null,
    sha: string,
  ) {
    const actual = await client.head(repo, branch);
    if (actual === sha) return;
    if (actual !== expected) throw new Error("Branch changed concurrently. Refresh and review before submitting.");
    if (actual)
      await client.request("PATCH", `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
        sha,
        force: false,
      });
    else await client.request("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
  }
  async function importSource(
    client: ReturnType<typeof createGitHubClient>,
    app: Deployment,
    link: AppRepositoryLink,
    sha: string,
    input: CollaborationInput,
    actor: string,
    operation: AppGitHubOperation,
  ) {
    const recovered = app.versions.find((v) => v.operationId === operation.id);
    if (
      input.confirmed !== true ||
      (!recovered && input.expectedVersion !== app.currentVersion) ||
      input.expectedSha !== sha
    )
      throw new Error("Review the import diff and confirm the current QM version and GitHub SHA.");
    const source = inDirectory((await client.tree(link.repository, sha)).files, link.directory);
    const files = [];
    for (const file of source) {
      const blob = await client.request<{ content: string; encoding: string }>(
        "GET",
        `/repos/${link.repository}/git/blobs/${file.sha}`,
      );
      if (blob.encoding !== "base64") throw new Error("Unsupported source encoding.");
      files.push({ path: file.path, data: Buffer.from(blob.content, "base64"), mode: parseInt(file.mode, 8) });
    }
    const current = await deps.store.versionOf(app.id, app.currentVersion);
    const privateFiles = ((await deps.store.filesOf(app.id, app.currentVersion)) ?? []).filter(
      (f) => !exportablePath(f.path),
    );
    files.push(...privateFiles.map((f) => ({ ...f, data: Buffer.from(f.data), mode: f.mode ?? 0o644 })));
    if (!current) throw new Error("Current release is missing.");
    const imported = await deps.deploy.redeploy(app.id, {
      entrypoint: current.entrypoint,
      files,
      publisher: actor,
      sourceSha: sha,
      title: input.title || `Import ${link.repository}`,
      description: input.description || `Imported GitHub commit ${sha}`,
      commitMessage: input.message || `Import ${sha}`,
      expectedVersion: input.expectedVersion,
      operationId: operation.id,
    });
    const importedVersion = imported.versions.find((v) => v.operationId === operation.id)!.version;
    link.baselineVersion = importedVersion;
    link.baselineSha = sha;
    await deps.links.put(app.id, link);
    return { version: importedVersion, sourceSha: sha };
  }
  return {
    async inspect(id: string, actor: string) {
      const app = await appFor(id, actor);
      const link = await deps.links.get(app.id);
      const operations = await deps.operations.select({ where: { field: "appId", anyOfFold: [app.id] } });
      let identity: GitHubIdentity | undefined, repository: GitHubRepository | undefined, error: string | undefined;
      try {
        const connected = await account(actor);
        identity = connected.identity;
        if (link && !link.unlinkedAt) {
          repository = await permissions(connected.client, link.repository, false);
          if (repository.id !== link.repositoryId)
            throw new Error("Repository identity changed. Unlink and review setup.");
          for (const operation of operations.filter((o) => o.pr && o.repositoryId === link.repositoryId)) {
            operation.pr = await connected.client.request<GitHubPullRequest>(
              "GET",
              `/repos/${link.repository}/pulls/${operation.pr!.number}`,
            );
            await deps.operations.merge(operation.id, { pr: operation.pr });
          }
        }
      } catch (e) {
        error = e instanceof Error ? e.message : "GitHub access check failed.";
      }
      const manage = await deps.deploy.canManageDeployment(app.id, actor);
      let githubAccess = "Repository write access missing";
      if (!identity) githubAccess = "GitHub not connected";
      else if (repository?.permissions?.push) githubAccess = "Write access ready";
      else if (
        operations.some((o) => o.invitation?.userId === identity?.id && o.invitation.id && !o.invitation.removedAt)
      )
        githubAccess = "Invitation pending";
      return {
        actorId: actor,
        link,
        operations,
        identity,
        error,
        canConfigure: await deps.canConfigure(app, actor),
        oauthConfigured: await deps.oauthConfigured?.(),
        qmAccess: manage ? "manage" : "view",
        githubAccess,
      };
    },
    async execute(id: string, actor: string, action: string, rawInput: CollaborationInput) {
      const input = collaborationInput(rawInput);
      const app = await appFor(
        id,
        actor,
        !["compare", "preview", "access", "import-preview", "create-preview", "submission-diff"].includes(action),
      );
      return deps.lock.withLock(`app-github:${app.id}`, async () => {
        const fresh = await appFor(
          app.id,
          actor,
          !["compare", "preview", "access", "import-preview", "create-preview", "submission-diff"].includes(action),
        );
        const ownerAction = [
          "create",
          "link",
          "invite",
          "remove-access",
          "unlink",
          "contributor-access",
          "create-preview",
        ].includes(action);
        if (ownerAction && !(await deps.canConfigure(fresh, actor)))
          throw new GitHubError(403, "Only the project or app owner can configure GitHub access.");
        if (action === "unlink") {
          if (input.confirmed !== true || !input.operationId || !/^[a-zA-Z0-9-]{8,100}$/.test(input.operationId))
            throw new Error("Confirm unlinking with an operation ID.");
          const key = `${app.id}:${input.operationId}`;
          const previous = await deps.operations.get(key);
          if (previous) {
            if (previous.actor !== actor || previous.action !== "unlink")
              throw new Error("Operation ID was already used.");
            if (previous.result !== undefined) return previous.result;
          }
          const link = await deps.links.get(app.id);
          if (!link) throw new Error("No repository link exists.");
          if (previous?.repositoryId !== undefined && previous.repositoryId !== link.repositoryId)
            throw new Error("Repository link changed. Review before unlinking.");
          await deps.operations.put(key, {
            id: key,
            appId: app.id,
            actor,
            action,
            input,
            requestHash: "unlink",
            at: previous?.at ?? Date.now(),
            repository: link.repository,
            repositoryId: link.repositoryId,
          });
          await deps.links.put(`${app.id}:${link.linkedAt}`, { ...link, unlinkedAt: Date.now() });
          await deps.links.put(app.id, { ...link, unlinkedAt: Date.now() });
          await deps.operations.put(key, {
            id: key,
            appId: app.id,
            actor,
            action,
            input,
            requestHash: "unlink",
            at: Date.now(),
            repository: link.repository,
            repositoryId: link.repositoryId,
            result: { unlinked: true },
          });
          return { unlinked: true };
        }
        const { client, identity } = await account(actor);
        if (action === "access") return { identity };
        if (action === "create-preview") {
          const target = await selected(fresh, input.version);
          return {
            files: target.tree,
            expectedSha: target.release.commit,
            expectedVersion: fresh.currentVersion,
            changes: target.files.map((f) => {
              const bytes = Buffer.from(f.data);
              return {
                path: f.path,
                before: null,
                after: bytes.length > 100_000 || bytes.includes(0) ? "Binary or large file" : bytes.toString("utf8"),
              };
            }),
          };
        }
        if (action === "contributor-access") {
          if (!input.principalId) throw new Error("Choose a contributor.");
          await appFor(app.id, input.principalId, true);
          const contributor = await account(input.principalId);
          return { identity: contributor.identity };
        }
        let operation: AppGitHubOperation | undefined;
        if (!["compare", "preview", "import-preview", "submission-diff"].includes(action)) {
          if (!input.operationId || !/^[a-zA-Z0-9-]{8,100}$/.test(input.operationId))
            throw new Error("A durable operationId is required.");
          const key = `${app.id}:${input.operationId}`;
          const requestHash = createHash("sha256")
            .update(
              JSON.stringify({
                actor,
                action,
                input: Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b))),
              }),
            )
            .digest("hex");
          operation = (await deps.operations.get(key)) ?? {
            id: key,
            appId: app.id,
            actor,
            action,
            requestHash,
            input,
            at: Date.now(),
          };
          if (operation.requestHash !== requestHash)
            throw new Error("Operation ID was already used for a different request.");
          if (operation.result !== undefined) return operation.result;
          await deps.operations.put(key, operation);
        }
        let result: unknown;
        if (action === "create") {
          if (input.confirmed !== true)
            throw new Error(
              "Confirm the personal account, private repository name, release, and export files before creating a repository.",
            );
          if (await deps.links.get(app.id).then((l) => l && !l.unlinkedAt && l.operationId !== operation?.id))
            throw new Error("Unlink the existing repository first.");
          if (!input.name || !/^[a-zA-Z0-9_.-]{1,100}$/.test(input.name)) throw new Error("Invalid repository name.");
          await selected(fresh, input.version);
          const repo = `${identity.login}/${input.name}`;
          const marker = `QM app ${app.id} setup ${operation!.id}`;
          let repository: GitHubRepository;
          try {
            repository = await client.repository(repo);
            if (repository.description !== marker || !repository.private)
              throw new Error("Repository already exists. Link it explicitly instead.");
          } catch (error) {
            if (!(error instanceof GitHubError) || error.status !== 404) throw error;
            repository = await client.request<GitHubRepository>("POST", "/user/repos", {
              name: input.name,
              private: true,
              auto_init: true,
              description: marker,
            });
          }
          operation!.repository = repo;
          operation!.repositoryId = repository.id;
          await deps.operations.put(operation!.id, operation!);
          const initial = await client.head(repo, repository.default_branch);
          if (!initial) throw new Error("Repository initialization is still pending. Retry this operation.");
          const parent = operation!.parent ?? initial;
          const sha =
            operation!.commit ??
            (
              await writeCommit(
                client,
                repo,
                "",
                parent,
                inDirectory((await client.tree(repo, parent)).files, ""),
                fresh,
                input,
                identity,
                operation!,
              )
            ).sha;
          await updateBranch(client, repo, "main", repository.default_branch === "main" ? parent : null, sha);
          await client.request("PATCH", `/repos/${repo}`, { default_branch: "main" });
          const link: AppRepositoryLink = {
            id: app.id,
            repository: repo,
            repositoryId: repository.id,
            base: "main",
            directory: "",
            configuredBy: actor,
            baselineVersion: input.version ?? fresh.currentVersion,
            baselineSha: sha,
            linkedAt: Date.now(),
            operationId: operation?.id,
          };
          await deps.links.put(app.id, link);
          result = { link };
        } else if (action === "link" || action === "compare") {
          const repo = repositoryName(input.repository ?? "");
          const repository = await permissions(client, repo, false);
          const base = branchName(input.base || repository.default_branch);
          const directory = directoryName(input.directory);
          const sha = await client.head(repo, base);
          if (!sha) throw new Error("Base branch does not exist.");
          const target = await selected(fresh, input.version);
          const remote = inDirectory((await client.tree(repo, sha)).files, directory);
          const changes = outgoingChanges(remote, target.tree, remote);
          const link: AppRepositoryLink = {
            id: app.id,
            repository: repo,
            repositoryId: repository.id,
            base,
            directory,
            configuredBy: actor,
            baselineVersion: target.release.version,
            baselineSha: sha,
            linkedAt: Date.now(),
            operationId: operation?.id,
          };
          if (action === "compare")
            return {
              link,
              changes: await reviewChanges(client, repo, changes, remote, target.files),
              files: target.tree,
              expectedVersion: fresh.currentVersion,
              expectedSha: sha,
            };
          if (
            input.confirmed !== true ||
            input.expectedSha !== sha ||
            (input.expectedVersion !== fresh.currentVersion &&
              !fresh.versions.some((v) => v.operationId === operation?.id))
          )
            throw new Error("Repository or QM source changed. Review the comparison again before linking.");
          if (await deps.links.get(app.id).then((l) => l && !l.unlinkedAt && l.operationId !== operation?.id))
            throw new Error("Unlink the existing repository first.");
          if (changes.length && !["import", "export"].includes(input.choice ?? ""))
            throw new Error("Choose import GitHub code or export QM code through a feature branch.");
          if (input.choice === "import")
            result = await importSource(client, fresh, link, sha, input, actor, operation!);
          else {
            await deps.links.put(app.id, link);
            result = { link, exportRequired: changes.length > 0 };
          }
        } else {
          const link = await activeLink(app.id);
          const repository = await permissions(
            client,
            link.repository,
            ["submit", "invite", "remove-access"].includes(action),
          );
          if (repository.id !== link.repositoryId)
            throw new Error("Repository identity changed. Unlink and review setup.");
          if (operation) {
            operation.repository = link.repository;
            operation.repositoryId = link.repositoryId;
          }
          if (action === "submission-diff") {
            const submission = input.submissionId ? await deps.operations.get(input.submissionId) : null;
            if (
              !submission?.commit ||
              !submission.parent ||
              submission.appId !== app.id ||
              submission.repositoryId !== link.repositoryId
            )
              throw new Error("Choose a recorded submission for this repository.");
            const before = inDirectory((await client.tree(link.repository, submission.parent)).files, link.directory);
            const after = inDirectory((await client.tree(link.repository, submission.commit)).files, link.directory);
            return {
              changes: await reviewChanges(client, link.repository, outgoingChanges(before, after, before), before),
            };
          }
          if (action === "preview" || action === "submit") {
            const branch = branchName(input.branch ?? `qm/v${input.version ?? fresh.currentVersion}-${Date.now()}`);
            if (branch === link.base) throw new Error("Direct submission to the base branch is prohibited.");
            const head = await client.head(link.repository, branch);
            if (!input.existingBranch && head && head !== operation?.commit)
              throw new Error("Branch already exists. Choose an existing branch explicitly or a new name.");
            if (input.existingBranch && !head) throw new Error("Selected branch does not exist.");
            const parent = operation?.parent ?? head ?? (await client.head(link.repository, link.base));
            if (!parent) throw new Error("Base branch is missing.");
            const previous = input.existingBranch
              ? (await deps.operations.all())
                  .filter(
                    (o) =>
                      o.appId === app.id &&
                      o.repositoryId === link.repositoryId &&
                      o.branch === branch &&
                      o.commit &&
                      o.id !== operation?.id &&
                      o.result !== undefined,
                  )
                  .sort((a, b) => b.at - a.at)[0]
              : undefined;
            const baseline = inDirectory(
              (await client.tree(link.repository, previous?.commit ?? link.baselineSha)).files,
              link.directory,
            );
            const destination = inDirectory((await client.tree(link.repository, parent)).files, link.directory);
            const target = await selected(fresh, input.version);
            const changes = outgoingChanges(baseline, target.tree, destination);
            if (action === "preview")
              return {
                branch,
                changes: await reviewChanges(client, link.repository, changes, destination, target.files),
                expectedSha: head ?? parent,
                expectedVersion: fresh.currentVersion,
                otherPublishers: [
                  ...new Set(
                    fresh.versions
                      .filter(
                        (v) =>
                          v.version > link.baselineVersion &&
                          v.version <= target.release.version &&
                          v.publisher &&
                          v.publisher !== actor,
                      )
                      .map((v) => v.publisher),
                  ),
                ],
              };
            if (input.confirmed !== true || !input.version || input.expectedSha !== parent)
              throw new Error("Review the outgoing diff and confirm the destination SHA and release.");
            if (!changes.length && !operation!.commit) throw new Error("No source changes to submit.");
            const sha =
              operation!.commit ??
              (
                await writeCommit(
                  client,
                  link.repository,
                  link.directory,
                  parent,
                  baseline,
                  fresh,
                  input,
                  identity,
                  operation!,
                )
              ).sha;
            operation!.commit = sha;
            operation!.parent = parent;
            operation!.branch = branch;
            operation!.release = target.release.version;
            operation!.changes = changes;
            await deps.operations.put(operation!.id, operation!);
            await appFor(app.id, actor, true);
            await permissions(client, link.repository, true);
            await updateBranch(client, link.repository, branch, input.existingBranch ? parent : null, sha);
            if (input.createPr !== false) {
              const existing = await client.request<GitHubPullRequest[]>(
                "GET",
                `/repos/${link.repository}/pulls?state=open&head=${encodeURIComponent(`${link.repository.split("/")[0]}:${branch}`)}&base=${encodeURIComponent(link.base)}`,
              );
              operation!.pr =
                existing[0] ??
                (await client.request<GitHubPullRequest>("POST", `/repos/${link.repository}/pulls`, {
                  head: branch,
                  base: link.base,
                  title: input.title?.trim() || target.release.title || `QM version ${target.release.version}`,
                  body: input.description ?? target.release.description ?? "",
                }));
              await deps.operations.put(operation!.id, operation!);
            }
            result = { commit: sha, pr: operation!.pr };
          } else if (action === "invite" || action === "remove-access") {
            if (input.confirmed !== true) throw new Error("Confirm the repository access change.");
            if (!repository.permissions?.admin)
              throw new GitHubError(
                403,
                `Repository administration permission is required. Manage access at https://github.com/${link.repository}/settings/access`,
              );
            if (action === "invite") {
              if (!input.principalId) throw new Error("Choose the contributor's QM identity.");
              await appFor(app.id, input.principalId, true);
              const contributor = await account(input.principalId);
              if (input.expectedGitHubUserId !== contributor.identity.id)
                throw new Error("Review and confirm the contributor’s verified GitHub identity.");
              const path = `/repos/${link.repository}/collaborators/${encodeURIComponent(contributor.identity.login)}`;
              let access: { permission: string } = { permission: "none" };
              try {
                access = await client.request<{ permission: string }>("GET", `${path}/permission`);
              } catch (error) {
                if (!(error instanceof GitHubError) || error.status !== 404) throw error;
              }
              if (!operation!.invitation && ["admin", "write", "maintain"].includes(access.permission))
                throw new Error("Contributor already has write access. Existing permissions are not managed by QM.");
              if (operation!.invitation && operation!.invitation.userId !== contributor.identity.id)
                throw new Error("Contributor GitHub identity changed. Review again.");
              operation!.invitation ??= {
                username: contributor.identity.login,
                userId: contributor.identity.id,
                granted: false,
              };
              await deps.operations.put(operation!.id, operation!);
              await appFor(app.id, input.principalId, true);
              if (!(await deps.canConfigure(await appFor(app.id, actor, true), actor)))
                throw new GitHubError(403, "Repository configuration access was removed.");
              const invitation = await client.request<{ id?: number } | undefined>("PUT", path, { permission: "push" });
              operation!.invitation = {
                ...operation!.invitation,
                ...(invitation?.id ? { id: invitation.id } : {}),
                granted: true,
              };
              await deps.operations.put(operation!.id, operation!);
              result = { invitation: operation!.invitation, url: `https://github.com/${link.repository}/invitations` };
            } else {
              const invitation = input.invitationId ? await deps.operations.get(input.invitationId) : null;
              if (
                !invitation?.invitation?.granted ||
                invitation.appId !== app.id ||
                invitation.repositoryId !== link.repositoryId
              )
                throw new Error("Only access originally granted through QM can be removed.");
              const currentIdentity = await client.request<GitHubIdentity>(
                "GET",
                `/users/${encodeURIComponent(invitation.invitation.username)}`,
              );
              if (currentIdentity.id !== invitation.invitation.userId)
                throw new Error("GitHub identity changed. Manage access in GitHub.");
              if (!invitation.invitation.removedAt && invitation.invitation.id) {
                try {
                  await client.request("DELETE", `/repos/${link.repository}/invitations/${invitation.invitation.id}`);
                } catch (error) {
                  if (!(error instanceof GitHubError) || error.status !== 404) throw error;
                  await client.request(
                    "DELETE",
                    `/repos/${link.repository}/collaborators/${encodeURIComponent(invitation.invitation.username)}`,
                  );
                }
              } else if (!invitation.invitation.removedAt)
                await client.request(
                  "DELETE",
                  `/repos/${link.repository}/collaborators/${encodeURIComponent(invitation.invitation.username)}`,
                );
              invitation.invitation.removedAt = Date.now();
              await deps.operations.put(invitation.id, invitation);
              result = { removed: true };
            }
          } else if (action === "import" || action === "import-preview") {
            const submission = input.submissionId ? await deps.operations.get(input.submissionId) : null;
            if (
              !submission?.pr ||
              submission.appId !== app.id ||
              submission.repositoryId !== link.repositoryId ||
              submission.pr.base.ref !== link.base
            )
              throw new Error("Choose a PR submitted for this app and base branch.");
            const pr = await client.request<GitHubPullRequest>(
              "GET",
              `/repos/${link.repository}/pulls/${submission.pr.number}`,
            );
            if (pr.base.ref !== link.base) throw new Error("PR base changed. Review the repository configuration.");
            if (!pr.merged_at || !pr.merge_commit_sha) throw new Error("This PR has not been merged.");
            if (action === "import-preview") {
              const source = inDirectory(
                (await client.tree(link.repository, pr.merge_commit_sha)).files,
                link.directory,
              );
              const current = await selected(fresh);
              return {
                changes: await reviewChanges(
                  client,
                  link.repository,
                  outgoingChanges(current.tree, source, current.tree),
                  [],
                  undefined,
                ).then((changes) =>
                  changes.map((change) => ({
                    ...change,
                    before: current.files.find((f) => f.path === change.path)?.data
                      ? Buffer.from(current.files.find((f) => f.path === change.path)!.data).toString("utf8")
                      : null,
                  })),
                ),
                expectedSha: pr.merge_commit_sha,
                expectedVersion: fresh.currentVersion,
                replacesNewerChanges: fresh.currentVersion !== submission.release,
              };
            }
            result = await importSource(client, fresh, link, pr.merge_commit_sha, input, actor, operation!);
          } else throw new Error("Unknown collaboration action.");
        }
        operation!.result = result;
        await deps.operations.put(operation!.id, operation!);
        return result;
      });
    },
  };
}

export type AppGitHubService = ReturnType<typeof createAppGitHubService>;
