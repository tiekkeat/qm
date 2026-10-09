import { AsyncLocalStorage } from "node:async_hooks";
import { redactSecrets } from "../harness/redact-secrets.ts";
import { errMessage } from "../util/errors.ts";
import type { App, AppDeps, ProjectView } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";
import type { SandboxResource, SandboxResources } from "../sandbox/sandbox-resources.ts";
import { parseScopeId, scopeId, type ScopeId } from "../types.ts";
import { projectGroupRef, projectScopeId, type Project } from "../projects/project-store.ts";
import { samePerson } from "../directory/person.ts";
import { createReaperKillHook } from "../processes/process-reaper.ts";
import { supportsProcessSessions } from "../sandbox/sandbox.ts";
import { stopSessionTree } from "../sessions/session-syscalls.ts";
import { isTerminal } from "../runs/run-store.ts";
import { sleep } from "../util/async.ts";
import { createNoopAdvisoryLock } from "../persistence/advisory-lock.ts";

export type SandboxAction = {
  action: "create" | "default" | "status" | "restart" | "retire";
  sandboxId?: string | null;
  backend?: string;
  name?: string;
  confirm?: boolean;
};
export type SandboxInventory = Awaited<ReturnType<SandboxResources["list"]>> & {
  manageable: boolean;
  jobs: Array<{ processId: string; sandboxId?: string; purpose: string }>;
  statuses?: Record<string, unknown>;
};
export interface ProjectDeletionPreview {
  project: ProjectView;
  sandboxes: SandboxResource[];
  jobs: SandboxInventory["jobs"];
  apps: Array<{ id: string; name: string }>;
  automations: number;
  blockers: Array<{ name: string; reason: string }>;
}
export interface ProjectArchive {
  memory: string;
  skills: Array<{ id: string; name: string; body: string }>;
}

export function createSandboxMethods(
  deps: AppDeps,
  h: AppHelpers,
): Pick<
  App,
  | "listSandboxes"
  | "manageSandbox"
  | "projectDeletionPreview"
  | "deleteProject"
  | "projectArchive"
  | "resumeProjectDeletions"
> {
  const lock = deps.advisoryLock ?? createNoopAdvisoryLock();
  const resources = () => {
    if (!deps.sandboxResources) throw new Error("sandbox management is unavailable");
    return deps.sandboxResources;
  };
  const recovering = new AsyncLocalStorage<{ actor: string; id: string }>();
  const resourcesFor = async (actor: string, scope: ScopeId) => {
    const parsed = parseScopeId(scope);
    const project =
      parsed.kind === "group" && deps.projects?.recognizes(parsed.ref)
        ? await deps.projects.get(parsed.ref.slice("web-project-".length))
        : null;
    return project?.lifecycle === "deleting" && project.deletion?.actorId === actor
      ? resources().forProjectDeletion(actor, scope)
      : resources();
  };
  const projectForOwner = async (actor: string, id: string): Promise<Project> => {
    const project = await deps.projects?.get(id);
    if (!project || !samePerson(project.ownerId, actor))
      throw new Error("only the project owner can delete this project");
    const recovery = recovering.getStore();
    if (
      recovery?.actor === actor &&
      recovery.id === id &&
      project.lifecycle === "deleting" &&
      project.deletion?.actorId === actor
    )
      return project;
    if (!deps.identity.isInternal(deps.identity.classify(actor)))
      throw new Error("only an active project owner can delete this project");
    if (!(await deps.projects!.readableMembership(projectGroupRef(id), actor))) throw new Error("project not found");
    return project;
  };
  const canManage = async (actor: string, scope: ScopeId) => {
    const parsed = parseScopeId(scope);
    if (!deps.identity.isInternal(deps.identity.classify(actor))) return false;
    if (parsed.kind === "personal") return samePerson(parsed.ref, actor);
    if (parsed.kind === "group" && deps.projects?.recognizes(parsed.ref))
      return deps.projects.canManage(parsed.ref, actor);
    return false;
  };
  const jobsFor = async (ids: string[], ownerScope: string) => {
    const selected = await resources().resolve(ownerScope);
    return ((await deps.processes?.listLive()) ?? []).filter((job) =>
      job.sandboxId
        ? ids.includes(job.sandboxId)
        : job.scopeId === ownerScope && !!selected && ids.includes(selected.id),
    );
  };
  const blockersFor = async (scope: ScopeId) => {
    const owner = (await deps.projects!.get(parseScopeId(scope).ref.slice("web-project-".length)))!.ownerId;
    const list = await (await resourcesFor(owner, scope)).list(owner, scope);
    const refs = list.sandboxes
      .filter((record) => record.ownerScopeId === scope)
      .flatMap((record) => [record.id, record.backingScopeId, ...(record.machineId ? [record.machineId] : [])]);
    refs.push(
      ...((await deps.mcpConnections?.inventory()) ?? [])
        .filter((connection) => connection.ownerScopeId === scope)
        .map((connection) => connection.id),
    );
    const blockers: Array<{ name: string; reason: string }> =
      (await deps.deploy.projectDeletionBlockers?.(scope, refs)) ?? [];
    for (const record of list.sandboxes)
      if (record.ownerScopeId === scope && record.state !== "retired" && !record.availableActions?.includes("retire"))
        blockers.push({
          name: record.name,
          reason:
            "This provider does not support sandbox retirement. Resolve this computer with the operator before deleting the project.",
        });
    return blockers;
  };
  const inventory = async (actor: string, scope: ScopeId): Promise<SandboxInventory> => {
    if (!(await h.principalCanAccessCurrentScope(actor, scope))) throw new Error("scope not found");
    const list = await resources().list(actor, scope);
    const sandboxes = list.sandboxes.filter((record) => record.ownerScopeId === scope);
    return {
      ...list,
      sandboxes: sandboxes.map((record) => ({
        ...record,
        ...(record.error
          ? { error: "Sandbox provisioning or cleanup failed; contact the operator for diagnostics." }
          : {}),
      })),
      manageable: await canManage(actor, scope),
      jobs: (
        await jobsFor(
          sandboxes.map((record) => record.id),
          scope,
        )
      ).map((job) => ({ processId: job.processId, sandboxId: job.sandboxId, purpose: job.purpose ?? job.kind })),
    };
  };
  const retire = async (actor: string, scope: ScopeId, id: string) => {
    const service = await resourcesFor(actor, scope);
    const record = await service.get(id);
    if (record.ownerScopeId !== scope) throw new Error("sandbox belongs to another scope");
    await service.blockExecution(actor, id);
    const jobs = await jobsFor([id], scope);
    if (jobs.length && (!deps.sandbox || !supportsProcessSessions(deps.sandbox)))
      throw new Error("this provider cannot stop running jobs; stop them before retrying retirement");
    if (deps.sandbox && supportsProcessSessions(deps.sandbox)) {
      const kill = createReaperKillHook(deps.sandbox, { lifecycleCleanup: true });
      for (const job of jobs) {
        await kill({ ...job, sandboxId: id });
        await deps.processes!.markStatus(job.processId, "reaped");
      }
    }
    if ((await service.resolve(scope))?.id === id) await service.setDefault(actor, scope, null);
    await service.retire(actor, id);
    deps.auditLog.record({
      at: Date.now(),
      principalId: actor,
      action: "sandbox.retire",
      resource: id,
      scopeLabel: scope,
    });
  };
  const methods: Pick<
    App,
    | "listSandboxes"
    | "manageSandbox"
    | "projectDeletionPreview"
    | "deleteProject"
    | "projectArchive"
    | "resumeProjectDeletions"
  > = {
    async resumeProjectDeletions() {
      const pending = (await deps.projects?.deleting()) ?? [];
      for (const project of pending) {
        await recovering
          .run({ actor: project.deletion!.actorId, id: project.id }, () =>
            methods.deleteProject(project.deletion!.actorId, project.id),
          )
          .catch((error) => deps.recordLifecycleError?.(projectScopeId(project.id), error));
      }
      return pending.length;
    },
    listSandboxes: inventory,
    async manageSandbox(actor, scope, input) {
      if (input.action === "status") {
        const list = await inventory(actor, scope);
        if (!input.sandboxId || !list.sandboxes.some((record) => record.id === input.sandboxId))
          throw new Error("sandbox not found");
        return { ...list, statuses: { [input.sandboxId]: await resources().status(actor, input.sandboxId) } };
      }
      if (!(await canManage(actor, scope))) throw new Error("only the sandbox owner can manage it");
      const service = resources();
      if (input.action === "create") {
        if (!input.backend) throw new Error("provider required");
        await service.create(actor, scope, input.backend, input.name);
      } else if (input.action === "default") {
        if (input.sandboxId === undefined) throw new Error("sandboxId required; use null to clear the default");
        await service.setDefault(actor, scope, input.sandboxId);
      } else {
        if (!input.sandboxId) throw new Error("sandboxId required");
        const record = await service.get(input.sandboxId);
        if (record.ownerScopeId !== scope) throw new Error("sandbox belongs to another scope");
        if (input.action === "retire") {
          if (!input.confirm) throw new Error("confirm retirement and stopping its running jobs");
          await retire(actor, scope, record.id);
        } else if (input.action === "restart") await service.restart(actor, record.id);
        else throw new Error("unsupported sandbox action");
      }
      deps.auditLog.record({
        at: Date.now(),
        principalId: actor,
        action: `sandbox.${input.action}`,
        resource: input.sandboxId ?? scope,
        scopeLabel: scope,
      });
      return inventory(actor, scope);
    },
    async projectDeletionPreview(actor, id) {
      const project = await projectForOwner(actor, id);
      const scope = projectScopeId(id);
      const list = await inventory(actor, scope);
      const apps = (await deps.deploy.listDeployments()).filter((app) => app.ownerScopeId === scope);
      const triggers = [
        ...(await deps.crons.list()),
        ...(await deps.webhooks.list()),
        ...((await deps.loopStore?.list()) ?? []),
        ...((await deps.monitors?.list()) ?? []),
      ].filter((trigger) => trigger.ownerScopeId === scope);
      return {
        project: await h.projectView(project),
        sandboxes: list.sandboxes.filter(
          (record) => record.state !== "retired" || record.cleanupPending || record.error,
        ),
        jobs: list.jobs,
        apps: apps.map((app) => ({ id: app.id, name: app.displayName ?? app.name ?? app.id })),
        automations: triggers.length,
        blockers: await blockersFor(scope),
      };
    },
    async deleteProject(actor, id) {
      await projectForOwner(actor, id);
      const scope = projectScopeId(id);
      return lock.withLock(`project-deletion:${id}`, async () => {
        let project = await lock.withLock(`project-work:${scope}`, async () => {
          const existing = await projectForOwner(actor, id);
          if (existing.lifecycle !== "archived") {
            const blockers = await blockersFor(scope);
            if (blockers.length)
              throw new Error(blockers.map((blocker) => `${blocker.name}: ${blocker.reason}`).join("\n"));
          }
          return existing.lifecycle === "deleting" || existing.lifecycle === "archived"
            ? existing
            : deps.projects!.beginDeletion(id, actor);
        });
        if (project.lifecycle === "archived") return h.projectView(project);
        const completed = [...project.deletion!.completed];
        const step = async (name: string, action: () => Promise<void>) => {
          if (completed.includes(name)) return;
          await action();
          completed.push(name);
          project = await deps.projects!.deletionProgress(id, [...completed]);
        };
        try {
          await step("automations", async () => {
            for (const cron of await deps.crons.list())
              if (cron.ownerScopeId === scope) await deps.crons.setEnabled(cron.id, false);
            for (const hook of await deps.webhooks.list())
              if (hook.ownerScopeId === scope) await deps.webhooks.setEnabled(hook.id, false);
            for (const loop of (await deps.loopStore?.list()) ?? [])
              if (loop.ownerScopeId === scope) await deps.loopStore!.setState(loop.id, "archived");
            for (const monitor of (await deps.monitors?.list()) ?? [])
              if (monitor.ownerScopeId === scope) await deps.monitors!.setEnabled(monitor.id, false);
          });
          await step("turns", async () => {
            const sessions = await deps.sessions.listByScope(scope);
            for (const session of sessions) {
              const runs = await deps.runs.inFlightForThread(session.threadRef);
              if (runs.length && !deps.signals) throw new Error("cannot stop active turns without a signal store");
              if (deps.signals)
                await stopSessionTree({ sessions: deps.sessions, runs: deps.runs, signals: deps.signals }, session);
            }
            const deadline = Date.now() + 10_000;
            while (true) {
              const runs = (
                await Promise.all(sessions.map((session) => deps.runs.inFlightForThread(session.threadRef)))
              ).flat();
              if (runs.every((run) => isTerminal(run.status))) break;
              if (Date.now() >= deadline) throw new Error("waiting for active turns to stop; retry deletion shortly");
              await sleep(100);
            }
          });
          await step("sandboxes", async () => {
            const blockers = await blockersFor(scope);
            if (blockers.length) throw new Error("published app dependencies must be moved before sandbox cleanup");
            const list = await (await resourcesFor(actor, scope)).list(actor, scope);
            for (const record of list.sandboxes)
              if (record.ownerScopeId === scope) await retire(actor, scope, record.id);
          });
          await step("connections", async () => {
            for (const connection of (await deps.mcpConnections?.inventory()) ?? [])
              if (connection.ownerScopeId === scope) await deps.mcpConnections!.delete(connection.id, actor, true);
          });
          await step("apps", async () => {
            for (const app of await deps.deploy.listDeployments())
              if (app.ownerScopeId === scope)
                await deps.deploy.transferDeploymentOwner(app.id, scopeId("personal", actor), {
                  callerId: actor,
                  projectDeletion: true,
                });
          });
          project = await deps.projects!.deletionProgress(id, completed, undefined, true);
          deps.auditLog.record({
            at: Date.now(),
            principalId: actor,
            action: "project.delete",
            resource: id,
            scopeLabel: scope,
          });
        } catch (error) {
          project = await deps.projects!.deletionProgress(
            id,
            completed,
            "Cleanup did not finish. Retry deletion; diagnostic details are recorded for the operator.",
          );
          deps.auditLog.record({
            at: Date.now(),
            principalId: actor,
            action: "project.delete.failed",
            resource: id,
            scopeLabel: scope,
            status: "failed",
          });
          console.error("[project-deletion]", id, redactSecrets(errMessage(error)));
          deps.recordLifecycleError?.(scope, error);
        }
        return h.projectView(project);
      });
    },
    async projectArchive(actor, id) {
      const project = await deps.projects?.get(id);
      if (
        !project ||
        project.lifecycle !== "archived" ||
        !(await deps.projects!.readableMembership(projectGroupRef(id), actor))
      )
        throw new Error("archive not found");
      const scope = projectScopeId(id);
      return {
        memory: (await deps.memory?.read(scope)) ?? "",
        skills: (await deps.skills.list())
          .filter((skill) => skill.scopeId === scope)
          .map((skill) => ({ id: skill.id, name: skill.manifest.name, body: skill.manifest.body })),
      };
    },
  };
  return methods;
}
