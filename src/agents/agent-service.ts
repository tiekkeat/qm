import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { DurableByteStore } from "../files/durable-byte-store.ts";
import type { AclStore } from "../acl/acl-store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import type { ProjectStore } from "../projects/project-store.ts";
import { parseScopeId, type ScopeId } from "../types.ts";
import { safeSkillFilePath } from "../skills/skill-store.ts";

export interface AgentFile {
  path: string;
  content: string;
  encoding?: "base64";
  mimetype?: string;
}
export interface AgentPackage {
  name: string;
  description: string;
  instructions: string;
  files: AgentFile[];
  allowedTools: string[] | null;
  requiredTools: string[];
  examples: Array<{ task: string; expected: string }>;
}
interface AgentRevision {
  version: number;
  blobKey: string;
  hash: string;
  author: string;
  at: number;
  summary: string;
  publishedAt?: number;
}
export interface CustomAgent {
  id: string;
  slug: string;
  ownerScopeId: ScopeId;
  createdBy: string;
  createdAt: number;
  name: string;
  description: string;
  publishedVersion: number | null;
  deletedAt?: number;
  revisions: AgentRevision[];
  proposals: Array<{ id: string; author: string; at: number; text: string }>;
}
export interface AgentSelection {
  id: string;
  version: number;
  test?: true;
}
export interface AgentBinding {
  scopeId: ScopeId;
  selection: AgentSelection | null;
}
export interface AgentView {
  id: string;
  slug: string;
  ownerScopeId: ScopeId;
  createdBy: string;
  name: string;
  description: string;
  publishedVersion: number | null;
  deleted: boolean;
  available: boolean;
  canEdit: boolean;
  canManage: boolean;
  version: number;
  revisions: Array<Omit<AgentRevision, "blobKey" | "hash">>;
  package: AgentPackage;
  proposals: CustomAgent["proposals"];
}
export class AgentError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}
export function validateAgentPackage(value: unknown): AgentPackage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AgentError("Agent package required");
  const p = value as Record<string, unknown>;
  for (const field of ["name", "description", "instructions"])
    if (typeof p[field] !== "string" || !(p[field] as string).trim()) throw new AgentError(`${field} is required`);
  if (
    (p.name as string).length > 120 ||
    (p.description as string).length > 1000 ||
    (p.instructions as string).length > 100_000
  )
    throw new AgentError("Agent instructions or metadata exceed the size limit");
  const strings = (v: unknown): string[] => {
    if (
      !Array.isArray(v) ||
      v.length > 200 ||
      v.some((x) => typeof x !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(x))
    )
      throw new AgentError("Tool restrictions require a list of exact tool names");
    return [...new Set(v as string[])].sort();
  };
  const paths = new Set<string>();
  if (p.files !== undefined && !Array.isArray(p.files)) throw new AgentError("files must be a list");
  const files = ((p.files ?? []) as unknown[])
    .map((raw) => {
      if (!raw || typeof raw !== "object") throw new AgentError("Invalid package file");
      const f = raw as AgentFile;
      if (typeof f.path !== "string" || typeof f.content !== "string")
        throw new AgentError("File path and content required");
      let path: string;
      try {
        path = safeSkillFilePath(f.path);
      } catch {
        throw new AgentError("Package file path is invalid");
      }
      if (path === "AGENT.md" || paths.has(path)) throw new AgentError("Duplicate or reserved file path");
      paths.add(path);
      if (f.encoding !== undefined && f.encoding !== "base64") throw new AgentError("Invalid file encoding");
      if (
        f.encoding === "base64" &&
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(f.content)
      )
        throw new AgentError("Invalid base64 file content");
      return {
        path,
        content: f.content,
        ...(f.encoding ? { encoding: f.encoding } : {}),
        ...(f.mimetype ? { mimetype: String(f.mimetype).slice(0, 120) } : {}),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.length > 100 || JSON.stringify(files).length > 5_000_000)
    throw new AgentError("Agent package files exceed the size limit");
  if (
    p.examples !== undefined &&
    (!Array.isArray(p.examples) ||
      p.examples.length > 30 ||
      p.examples.some((e) => !e || typeof e.task !== "string" || typeof e.expected !== "string"))
  )
    throw new AgentError("Examples require task and expected text");
  return {
    name: (p.name as string).trim(),
    description: (p.description as string).trim(),
    instructions: p.instructions as string,
    files,
    allowedTools: p.allowedTools == null ? null : strings(p.allowedTools),
    requiredTools: strings(p.requiredTools ?? []),
    examples: ((p.examples ?? []) as AgentPackage["examples"]).map((e) => ({
      task: e.task.slice(0, 10_000),
      expected: e.expected.slice(0, 10_000),
    })),
  };
}
export function createAgentService(opts: {
  agents: DurableMap<CustomAgent>;
  bindings: DurableMap<AgentBinding>;
  bytes: DurableByteStore;
  lock: AdvisoryLock;
  acl: AclStore;
  audit: AuditLog;
  projects: ProjectStore;
  active(scope: ScopeId): Promise<boolean>;
  write<T>(scopes: readonly ScopeId[], action: () => Promise<T>): Promise<T>;
  canRead(actor: string, scope: ScopeId): Promise<boolean>;
  canWrite(actor: string, scope: ScopeId): Promise<boolean>;
  internal(actor: string): boolean;
  retire?(id: string): Promise<unknown>;
  audience?(scope: ScopeId): Promise<string[] | undefined>;
  skillSnapshot?(actor: string, id: string): Promise<{ files: AgentFile[]; root: string; summary: string }>;
}) {
  const ref = (id: string) => `agent:${id}`;
  const record = (actor: string, action: string, a: CustomAgent) =>
    opts.audit.record({
      at: Date.now(),
      principalId: actor,
      action: `agent.${action}`,
      resource: a.id,
      scopeLabel: a.ownerScopeId,
    });
  async function manage(actor: string, a: CustomAgent): Promise<boolean> {
    if (!opts.internal(actor)) return false;
    const scope = parseScopeId(a.ownerScopeId);
    if (scope.kind === "personal") return scope.ref === actor;
    const p = scope.ref?.startsWith("web-project-") ? await opts.projects.get(scope.ref.slice(12)) : null;
    return p?.ownerId === actor && !!(await opts.canRead(actor, a.ownerScopeId));
  }
  async function permission(actor: string, a: CustomAgent, actingScope?: ScopeId): Promise<"read" | "write" | null> {
    if (!opts.internal(actor)) return null;
    if (await manage(actor, a)) return "write";
    if (a.deletedAt) return null;
    const home = await opts.canRead(actor, a.ownerScopeId);
    if (home && a.createdBy === actor && (await opts.active(a.ownerScopeId))) return "write";
    if (!(await opts.active(a.ownerScopeId))) return home ? "read" : null;
    const grants = await opts.acl.grantsFor(a.ownerScopeId, ref(a.id));
    const matches = home ? ["read"] : [];
    for (const g of grants)
      if (
        (await opts.active(g.granteeScopeId)) &&
        (await opts.canRead(actor, g.granteeScopeId)) &&
        (!actingScope || g.granteeScopeId === `personal:${actor}` || g.granteeScopeId === actingScope)
      )
        matches.push(g.permission);
    if (matches.includes("write")) return "write";
    return matches.includes("read") ? "read" : null;
  }
  async function get(id: string): Promise<CustomAgent> {
    const a = await opts.agents.get(id);
    if (!a) throw new AgentError("Agent not found", 404);
    return a;
  }
  async function packageOf(a: CustomAgent, version: number): Promise<AgentPackage> {
    const v = a.revisions.find((r) => r.version === version);
    if (!v) throw new AgentError("Version not found", 404);
    const opened = await opts.bytes.open(v.blobKey);
    if (!opened) throw new AgentError("Agent package unavailable", 503);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as AgentPackage;
  }
  async function view(actor: string, id: string, version?: number, scope?: ScopeId): Promise<AgentView> {
    const a = await get(id);
    const perm = await permission(actor, a, scope);
    const owner = await manage(actor, a);
    if (!perm) throw new AgentError("Agent not found", 404);
    const active = !a.deletedAt && (await opts.active(a.ownerScopeId));
    const edit = perm === "write" && active;
    const latestVisible = edit || owner ? a.revisions.length : a.publishedVersion;
    const requested = version ?? latestVisible;
    if (!requested || (!edit && !owner && !a.revisions.some((r) => r.version === requested && r.publishedAt)))
      throw new AgentError("Agent version unavailable", 403);
    const p = await packageOf(a, requested);
    return {
      id: a.id,
      slug: a.slug,
      ownerScopeId: a.ownerScopeId,
      createdBy: a.createdBy,
      name: p.name,
      description: p.description,
      publishedVersion: a.publishedVersion,
      deleted: !!a.deletedAt,
      available: active && a.publishedVersion !== null,
      canEdit: edit,
      canManage: owner && active,
      version: requested,
      package: p,
      revisions: (edit || owner ? a.revisions : a.revisions.filter((r) => r.version === requested)).map(
        ({ blobKey: _blobKey, hash: _hash, ...r }) => r,
      ),
      proposals: edit || owner ? a.proposals : [],
    };
  }
  async function mutate<T>(
    actor: string,
    id: string,
    ownerOnly: boolean,
    action: (a: CustomAgent) => Promise<T>,
    allowDeleted = false,
  ): Promise<T> {
    return opts.lock.withLock(`agent:${id}`, async () => {
      const a = await get(id);
      return opts.write([a.ownerScopeId], async () => {
        if (
          (a.deletedAt && !allowDeleted) ||
          !(ownerOnly ? await manage(actor, a) : (await permission(actor, a)) === "write")
        )
          throw new AgentError("Not authorized to change this agent", 403);
        return action(a);
      });
    });
  }
  async function revision(a: CustomAgent, p: AgentPackage, actor: string, summary: string): Promise<void> {
    const blob = await opts.bytes.put(Buffer.from(JSON.stringify(p)), { maxBytes: 6_000_000 });
    if (a.revisions.at(-1)?.hash === blob.sha256) return;
    a.revisions.push({
      version: a.revisions.length + 1,
      blobKey: blob.blobKey,
      hash: blob.sha256,
      author: actor,
      at: Date.now(),
      summary: summary.slice(0, 1000),
    });
    a.name = p.name;
    a.description = p.description;
    await opts.agents.put(a.id, a);
    record(actor, "save", a);
  }
  async function retire(a: CustomAgent) {
    for (const [key, b] of await opts.bindings.entries())
      if (b.selection?.id === a.id && key.startsWith("default:"))
        await opts.bindings.mutateMany([
          {
            id: key,
            apply: (current) =>
              current?.selection?.id === a.id
                ? { ...current, selection: null }
                : (current ?? { scopeId: b.scopeId, selection: null }),
          },
        ]);
    await opts.retire?.(a.id);
  }
  return {
    raw: opts.agents,
    async recoverDeletions() {
      for (const a of await opts.agents.all())
        if (a.deletedAt || !(await opts.active(a.ownerScopeId)))
          await opts.lock.withLock(`agent:${a.id}`, () => retire(a));
    },
    async list(actor: string, scope?: ScopeId, deleted = false): Promise<AgentView[]> {
      const out = [];
      for (const a of await opts.agents.all()) {
        if (a.deletedAt && !deleted) continue;
        if (await permission(actor, a, scope)) {
          try {
            out.push(await view(actor, a.id, undefined, scope));
          } catch (e) {
            if (!(e instanceof AgentError && e.status === 403)) throw e;
          }
        }
      }
      return out;
    },
    view,
    async create(actor: string, scope: ScopeId, input: unknown): Promise<AgentView> {
      const p = validateAgentPackage(input);
      const parsed = parseScopeId(scope);
      if (!(parsed.kind === "personal" || (parsed.kind === "group" && parsed.ref?.startsWith("web-project-"))))
        throw new AgentError("Choose a personal or project workspace");
      return opts.lock.withLock(`agent-name:${scope}`, () =>
        opts.write([scope], async () => {
          if (!opts.internal(actor) || !(await opts.canWrite(actor, scope)))
            throw new AgentError("Not authorized to create here", 403);
          const base =
            p.name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "") || "custom-agent";
          let slug = base;
          let n = 2;
          const existing = await opts.agents.all();
          while (existing.some((a) => a.ownerScopeId === scope && a.slug === slug)) slug = `${base}-${n++}`;
          const a: CustomAgent = {
            id: randomUUID(),
            slug,
            ownerScopeId: scope,
            createdBy: actor,
            createdAt: Date.now(),
            name: p.name,
            description: p.description,
            publishedVersion: null,
            revisions: [],
            proposals: [],
          };
          await revision(a, p, actor, "Created agent");
          record(actor, "create", a);
          return view(actor, a.id);
        }),
      );
    },
    async save(actor: string, id: string, input: unknown, expected: number, summary = "Updated package") {
      const p = validateAgentPackage(input);
      return mutate(actor, id, false, async (a) => {
        if (expected !== a.revisions.length)
          throw new AgentError("Agent changed. Reload and reconcile your edits.", 409);
        await revision(a, p, actor, summary);
        return view(actor, id);
      });
    },
    async importSkill(actor: string, id: string, skillId: string, expected: number) {
      const current = await view(actor, id);
      if (!current.canEdit || !opts.skillSnapshot) throw new AgentError("Skill import unavailable", 403);
      const snapshot = await opts.skillSnapshot(actor, skillId);
      return this.save(
        actor,
        id,
        {
          ...current.package,
          files: [...current.package.files.filter((f) => !f.path.startsWith(`${snapshot.root}/`)), ...snapshot.files],
        },
        expected,
        snapshot.summary,
      );
    },
    async publish(actor: string, id: string, version: number) {
      return mutate(actor, id, false, async (a) => {
        if (!a.revisions.some((v) => v.version === version)) throw new AgentError("Version not found", 404);
        a.revisions.find((r) => r.version === version)!.publishedAt ??= Date.now();
        a.publishedVersion = version;
        await opts.agents.put(id, a);
        record(actor, "publish", a);
        return view(actor, id);
      });
    },
    async restore(actor: string, id: string, version: number, expected: number) {
      return mutate(actor, id, false, async (a) => {
        if (expected !== a.revisions.length) throw new AgentError("Agent changed. Reload first.", 409);
        await revision(a, await packageOf(a, version), actor, `Restored v${version}`);
        return view(actor, id);
      });
    },
    async propose(actor: string, id: string, text: string) {
      return mutateProposal();
      async function mutateProposal() {
        return opts.lock.withLock(`agent:${id}`, async () => {
          const a = await get(id);
          if (
            !text.trim() ||
            text.length > 10_000 ||
            a.deletedAt ||
            !(await opts.active(a.ownerScopeId)) ||
            !(await permission(actor, a))
          )
            throw new AgentError("Cannot submit this suggestion", 403);
          return opts.write([a.ownerScopeId], async () => {
            a.proposals.push({ id: randomUUID(), author: actor, at: Date.now(), text });
            await opts.agents.put(id, a);
            record(actor, "propose", a);
            return { ok: true };
          });
        });
      }
    },
    async grants(actor: string, id: string) {
      const a = await get(id);
      if (!(await manage(actor, a))) throw new AgentError("Only the owner manages sharing", 403);
      return opts.acl.grantsFor(a.ownerScopeId, ref(id));
    },
    async share(actor: string, id: string, target: ScopeId, role: "user" | "contributor" | null) {
      return mutate(actor, id, true, async (a) => {
        const parsedTarget = parseScopeId(target);
        const kind = parsedTarget.kind;
        if (
          kind === "group" &&
          (!parsedTarget.ref?.startsWith("web-project-") || !(await opts.projects.get(parsedTarget.ref.slice(12))))
        )
          throw new AgentError("Project not found");
        if (
          !["personal", "group"].includes(kind ?? "") ||
          !(await opts.active(target)) ||
          (kind === "personal" && !opts.internal(parseScopeId(target).ref!))
        )
          throw new AgentError("Choose an active user or project");
        const existing = await opts.acl.grantsFor(a.ownerScopeId, ref(id));
        const replacement = existing.filter((grant) => grant.granteeScopeId !== target);
        if (role !== null)
          replacement.push({
            ownerScopeId: a.ownerScopeId,
            ref: ref(id),
            granteeScopeId: target,
            permission: role === "contributor" ? "write" : "read",
            grantedBy: actor,
          });
        if (
          !(await opts.acl.replaceGrantsIfCurrent(a.ownerScopeId, ref(id), existing, replacement, actor, a.createdBy))
        )
          throw new AgentError("Agent sharing changed. Reload and retry.", 409);
        record(actor, "share", a);
        return view(actor, id);
      });
    },
    async delete(actor: string, id: string, confirm: boolean) {
      if (!confirm) throw new AgentError("Deletion confirmation required");
      return mutate(
        actor,
        id,
        true,
        async (a) => {
          a.deletedAt ??= Date.now();
          await opts.agents.put(id, a);
          await retire(a);
          record(actor, "delete", a);
          return { ok: true };
        },
        true,
      );
    },
    async bind(actor: string, key: string, scope: ScopeId, selection: AgentSelection | null) {
      if (key.startsWith("default:") && selection?.test) throw new AgentError("Defaults require a published version");
      if (!(await opts.canWrite(actor, scope))) throw new AgentError("Cannot select an agent here", 403);
      if (key.startsWith("default:") && parseScopeId(scope).kind === "group") {
        const p = await opts.projects.get(parseScopeId(scope).ref!.slice(12));
        if (p?.ownerId !== actor) throw new AgentError("Only the project owner changes the default", 403);
      }
      const commit = () =>
        opts.write([scope], async () => {
          if (selection) {
            await this.admit(actor, scope, selection);
            for (const member of (await opts.audience?.(scope)) ?? []) await this.admit(member, scope, selection);
          }
          await opts.bindings.put(key, { scopeId: scope, selection });
          return { selection };
        });
      return selection ? opts.lock.withLock(`agent:${selection.id}`, commit) : commit();
    },
    async effectiveSelection(actor: string, scope: ScopeId, thread: string): Promise<AgentSelection | null> {
      const selected = await this.binding(`selection:${thread}`, scope);
      if (selected !== undefined) return selected;
      const fallback = await this.binding(`default:${scope}`, scope);
      if (!fallback) return null;
      try {
        const a = await view(actor, fallback.id, undefined, scope);
        return a.available ? { id: a.id, version: a.publishedVersion! } : null;
      } catch (error) {
        if (error instanceof AgentError && [403, 404].includes(error.status)) return null;
        throw error;
      }
    },
    async binding(key: string, scope: ScopeId): Promise<AgentSelection | null | undefined> {
      const b = await opts.bindings.get(key);
      return b?.scopeId === scope ? b.selection : undefined;
    },
    async admit(
      actor: string,
      scope: ScopeId,
      selection: AgentSelection,
    ): Promise<{ agent: CustomAgent; package: AgentPackage }> {
      const a = await get(selection.id);
      const perm = await permission(actor, a, scope);
      if (a.deletedAt || !(await opts.active(a.ownerScopeId)) || !perm || (selection.test && perm !== "write"))
        throw new AgentError("Selected agent is unavailable. Choose another agent.", 403);
      if (
        !selection.test &&
        (!a.publishedVersion || !a.revisions.some((v) => v.version === selection.version && !!v.publishedAt))
      )
        throw new AgentError("Agent version has not been published", 403);
      return { agent: a, package: await packageOf(a, selection.version) };
    },
    async resolve(actor: string, scope: ScopeId, name: string): Promise<AgentSelection> {
      const matches = (await this.list(actor, scope)).filter((a) => a.available && (a.id === name || a.slug === name));
      if (matches.length !== 1)
        throw new AgentError(
          matches.length ? "Several agents match. Select one by owner in the dropdown." : "Agent not found",
          409,
        );
      return { id: matches[0]!.id, version: matches[0]!.publishedVersion! };
    },
  };
}
export type AgentService = ReturnType<typeof createAgentService>;
