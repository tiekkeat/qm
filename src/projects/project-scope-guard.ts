import { AsyncLocalStorage } from "node:async_hooks";
import type { ProjectStore } from "./project-store.ts";
import { parseScopeId, type ScopeId } from "../types.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { MemoryService } from "../memory/memory-service.ts";
import type { SkillStore } from "../skills/skill-store.ts";
import type { WorkspaceStore } from "../workspace/workspace-store.ts";
import type { FileArtifactStore } from "../files/file-artifact-store.ts";

export function createProjectScopeGuard(projects: ProjectStore, lock: AdvisoryLock) {
  const held = new AsyncLocalStorage<{ scopes: Set<ScopeId>; active: boolean }>();
  const active = async (scope: ScopeId): Promise<boolean> => {
    const parsed = parseScopeId(scope);
    return parsed.kind !== "group" || !projects.recognizes(parsed.ref) || (await projects.writable(parsed.ref));
  };
  const write = async <T>(scopes: readonly ScopeId[], action: () => Promise<T>): Promise<T> => {
    const targets = [...new Set(scopes)].sort();
    const next = async (index: number): Promise<T> => {
      if (index === targets.length) return action();
      const scope = targets[index]!;
      const parsed = parseScopeId(scope);
      if (parsed.kind !== "group" || !projects.recognizes(parsed.ref)) return next(index + 1);
      const parent = held.getStore();
      if (parent?.active && parent.scopes.has(scope)) return next(index + 1);
      const withLock = lock.withSharedLock ?? lock.withLock;
      return withLock(`project-work:${scope}`, async () => {
        if (!(await active(scope))) throw new Error("project is read-only");
        const context = { scopes: new Set([...(parent?.active ? parent.scopes : []), scope]), active: true };
        return held.run(context, async () => {
          try {
            return await next(index + 1);
          } finally {
            context.active = false;
          }
        });
      });
    };
    return next(0);
  };
  const memory = (store: MemoryService): MemoryService => ({
    ...store,
    ...(store.withDisclosure ? { withDisclosure: (access) => memory(store.withDisclosure!(access)) } : {}),
    recall: async (scope, context) => ((await active(scope)) ? store.recall(scope, context) : []),
    query: async (scope, query, limit, context) =>
      (await active(scope)) ? store.query(scope, query, limit, context) : [],
    capture: (scope, ...args) => write([scope], () => store.capture(scope, ...args)),
    ...(store.edit ? { edit: (scope, ...args) => write([scope], () => store.edit!(scope, ...args)) } : {}),
    ...(store.delete ? { delete: (scope, ...args) => write([scope], () => store.delete!(scope, ...args)) } : {}),
  });
  const skills = (store: SkillStore): SkillStore => {
    const change = async <T>(id: string, action: () => Promise<T>, target?: ScopeId): Promise<T> => {
      return lock.withLock(`project-skill:${id}`, async () => {
        const skill = await store.get(id);
        return write([...(skill ? [skill.scopeId] : []), ...(target ? [target] : [])], action);
      });
    };
    const activeScopes = async (scopes: ScopeId[]) =>
      (await Promise.all(scopes.map(async (scope) => ((await active(scope)) ? scope : null)))).filter(
        (scope): scope is ScopeId => scope !== null,
      );
    return {
      ...store,
      create: (input) => write([input.scopeId], () => store.create(input)),
      update: (id, ...args) => change(id, () => store.update(id, ...args)),
      review: (id, ...args) => change(id, () => store.review(id, ...args)),
      publish: (id) => change(id, () => store.publish(id)),
      archive: (id) => change(id, () => store.archive(id)),
      restore: (skill) => change(skill.id, () => store.restore(skill), skill.scopeId),
      delete: (id) => change(id, () => store.delete(id)),
      promote: (id, scope) => change(id, () => store.promote(id, scope), scope),
      move: (id, scope) => change(id, () => store.move(id, scope), scope),
      recordUse: async (id, at) => {
        const skill = await store.get(id);
        if (skill && (await active(skill.scopeId))) await change(id, () => store.recordUse(id, at));
      },
      resolve: async (name, scopes) => store.resolve(name, await activeScopes(scopes)),
      visibleFor: async (scopes, granted) => {
        const allowed = (
          await Promise.all((granted ?? []).map(async (ref) => ((await active(ref.ownerScopeId)) ? ref : null)))
        ).filter((ref) => ref !== null);
        return store.visibleFor(await activeScopes(scopes), allowed);
      },
    };
  };
  const workspace = (store: WorkspaceStore): WorkspaceStore => ({
    ...store,
    write: (scope, ...args) => write([scope], () => store.write(scope, ...args)),
    remove: (scope, ...args) => write([scope], () => store.remove(scope, ...args)),
  });
  const files = (store: FileArtifactStore): FileArtifactStore => {
    const change = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
      const file = await store.get(id, { includeDisabled: true });
      return write(file ? [file.ownerScopeId, ...(file.createdInScope ? [file.createdInScope] : [])] : [], action);
    };
    return {
      ...store,
      put: (input) =>
        write([input.ownerScopeId, ...(input.createdInScope ? [input.createdInScope] : [])], () => store.put(input)),
      publish: (input) =>
        write([input.ownerScopeId, ...(input.createdInScope ? [input.createdInScope] : [])], () =>
          store.publish(input),
        ),
      setEnabled: (id, enabled) => change(id, () => store.setEnabled(id, enabled)),
      delete: (id) => change(id, () => store.delete(id)),
    };
  };
  return { active, write, memory, skills, workspace, files };
}
