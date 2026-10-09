import { redactSecrets } from "../harness/redact-secrets.ts";
import { errMessage } from "../util/errors.ts";
import { withLiveTurnMembership } from "../resolution/scope-membership.ts";
import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { parseScopeId, type CommandPolicy, type EgressPolicy, type ScopeId } from "../types.ts";
import type { SandboxBackendName } from "./sandbox-routing.ts";
import type { Sandbox, AgentComputerSpec, ProvisionOptions, ComputerStatus } from "./sandbox.ts";

export interface SandboxResource {
  id: string;
  backend: SandboxBackendName;
  ownerScopeId: ScopeId;
  backingScopeId: string;
  name: string;
  createdBy: string;
  createdAt: string;
  legacy: boolean;
  state: "unverified" | "provisioning" | "ready" | "failed" | "retired";
  availableActions?: string[];
  machineId?: string;
  cleanupPending?: boolean;
  executionBlocked?: boolean;
  spec?: AgentComputerSpec;
  error?: string;
}

export interface SandboxAccessPlan {
  readonly resource: SandboxResource;
  readonly crossScope: boolean;
  readonly egress: EgressPolicy;
  readonly commandPolicy: CommandPolicy | null;
  readonly credentialScopeId?: ScopeId;
  readonly env?: Readonly<Record<string, string>>;
}

export interface SandboxDefault {
  sandboxId: string | null;
}

export interface SandboxResources {
  forProjectDeletion(actorId: string, scopeId: ScopeId): Promise<SandboxResources>;
  forTurn(turn: { actorId: string; scopeId: ScopeId; isCurrent: () => Promise<boolean> }): SandboxResources;
  initialize(): Promise<void>;
  list(
    actorId: string,
    scopeId: ScopeId,
  ): Promise<{
    sandboxes: SandboxResource[];
    defaultSandboxId: string | null;
    defaultMode: "none" | "selected";
    providers: Array<{ name: SandboxBackendName; spec?: AgentComputerSpec; actions: string[] }>;
  }>;
  create(
    actorId: string,
    scopeId: ScopeId,
    backend: string,
    name?: string,
    reservationId?: string,
  ): Promise<SandboxResource>;
  access(actorId: string, id: string): Promise<SandboxResource>;
  status(actorId: string, id: string): Promise<ComputerStatus>;
  restart(actorId: string, id: string): Promise<void>;
  blockExecution(actorId: string, id: string): Promise<void>;
  retire(actorId: string, id: string): Promise<void>;
  use<T>(id: string, action: () => Promise<T>, exclusive?: boolean, cleanup?: boolean): Promise<T>;
  setDefault(actorId: string, scopeId: ScopeId, id: string | null): Promise<void>;
  resolve(scopeId: ScopeId): Promise<SandboxResource | null>;
  get(id: string): Promise<SandboxResource>;
  defaultBackend(): SandboxBackendName;
}

export function createSandboxResources(opts: {
  upgrade?: () => Promise<void>;
  records: DurableMap<SandboxResource>;
  defaults: DurableMap<SandboxDefault>;
  backends: Partial<Record<SandboxBackendName, Sandbox>>;
  defaultBackend: SandboxBackendName;
  provisionOptions?: (scopeId: string) => Promise<ProvisionOptions>;
  beforeDefaultChange?: (scopeId: string) => Promise<void>;
  onLifecycleError?: (record: SandboxResource, error: unknown) => void;
  beforeRetire?: (record: SandboxResource) => Promise<void>;
  lock: AdvisoryLock;
  canCleanupScope?(actorId: string, scopeId: ScopeId): Promise<boolean>;
  canManageScope?(actorId: string, scopeId: ScopeId): Promise<boolean>;
  canReadScope?(actorId: string, scopeId: ScopeId): Promise<boolean>;
  scopeIsActive?(scopeId: ScopeId): Promise<boolean>;
  canUseScope(actorId: string, scopeId: ScopeId): Promise<boolean>;
}): SandboxResources {
  let upgraded: Promise<void> | undefined;
  const initialize = async (): Promise<void> => {
    if (!opts.upgrade) return;
    upgraded ??= opts.upgrade().catch((error: unknown) => {
      upgraded = undefined;
      throw error;
    });
    await upgraded;
  };
  const actionsFor = (backend: Sandbox | undefined): string[] => {
    if (!backend) return [];
    return [
      "create",
      ...(backend.computerStatus ? ["status"] : []),
      ...(backend.restartComputer ? ["restart"] : []),
      ...(backend.destroyScope ? ["retire"] : []),
    ];
  };
  const authorize = async (actorId: string, scopeId: ScopeId): Promise<void> => {
    if (!parseScopeId(scopeId).kind || !(await opts.canUseScope(actorId, scopeId)))
      throw new Error("sandbox access requires permission to use its owning scope");
  };
  const authorizeManage = async (actorId: string, scopeId: ScopeId): Promise<void> => {
    if (!(await (opts.canManageScope ?? opts.canUseScope)(actorId, scopeId)))
      throw new Error("sandbox management requires permission from its owner");
  };
  const requireActive = async (scopeId: ScopeId): Promise<void> => {
    if (opts.scopeIsActive && !(await opts.scopeIsActive(scopeId))) throw new Error("project is read-only");
  };
  const get = async (id: string): Promise<SandboxResource> => {
    await initialize();
    const record = await opts.records.get(id);
    if (!record) throw new Error(`sandbox not found: ${id}`);
    return record;
  };
  const use = async <T>(id: string, action: () => Promise<T>, exclusive = false, cleanup = false): Promise<T> => {
    await get(id);
    const lock = exclusive || !opts.lock.withSharedLock ? opts.lock.withLock : opts.lock.withSharedLock;
    return lock(`sandbox-resource:${id}`, async () => {
      const current = await get(id);
      if (current.state === "retired") throw new Error("sandbox has been retired");
      if (!cleanup) {
        if (current.executionBlocked) throw new Error("sandbox retirement is pending");
        await requireActive(current.ownerScopeId);
      }
      return action();
    });
  };
  return {
    async forProjectDeletion(actorId, scopeId) {
      if (!(await opts.canCleanupScope?.(actorId, scopeId)))
        throw new Error("project cleanup has no persisted authorization");
      const authorizeCleanup = async (actor: string, target: ScopeId) =>
        actor === actorId && target === scopeId && (await opts.canCleanupScope?.(actorId, scopeId)) === true;
      return createSandboxResources({
        ...opts,
        canUseScope: authorizeCleanup,
        canReadScope: authorizeCleanup,
        canManageScope: authorizeCleanup,
      });
    },
    forTurn: (turn) =>
      createSandboxResources({
        ...opts,
        canUseScope: async (actorId, scopeId) =>
          withLiveTurnMembership(opts.canUseScope, { ...turn, verified: await turn.isCurrent() })(actorId, scopeId),
      }),
    defaultBackend: () => opts.defaultBackend,
    initialize,
    get,
    use,
    async blockExecution(actorId, id) {
      const record = await get(id);
      await authorizeManage(actorId, record.ownerScopeId);
      await opts.lock.withLock(`sandbox-resource:${id}`, async () => {
        const current = await get(id);
        if (current.state !== "retired") await opts.records.put(id, { ...current, executionBlocked: true });
      });
    },
    async retire(actorId, id) {
      await initialize();
      const record = await get(id);
      await authorizeManage(actorId, record.ownerScopeId);
      await opts.lock.withLock(`sandbox-resource:${id}`, () =>
        opts.lock.withLock(`sandbox-default:${record.ownerScopeId}`, async () => {
          const current = await get(id);
          if (current.state === "retired" && !current.cleanupPending && !current.error) return;
          const selected = await opts.defaults.get(current.ownerScopeId);
          if (selected?.sandboxId === id)
            throw new Error("unset or change this scope's default before retiring its computer");
          await opts.beforeRetire?.(current);
          const backend = opts.backends[current.backend];
          if (!backend?.destroyScope) throw new Error(`sandbox retirement unavailable: ${current.backend}`);
          const retiring = { ...current, state: "retired" as const, cleanupPending: true };
          await opts.records.put(id, retiring);
          try {
            await backend.destroyScope(current.backingScopeId);
            await opts.records.put(id, { ...retiring, cleanupPending: false, error: undefined });
          } catch (error) {
            opts.onLifecycleError?.(current, error);
            await opts.records.put(id, { ...retiring, error: redactSecrets(errMessage(error)) });
            throw error;
          }
        }),
      );
    },
    async access(actorId, id) {
      const record = await get(id);
      await authorize(actorId, record.ownerScopeId);
      return record;
    },
    async status(actorId, id) {
      const record = await get(id);
      await authorize(actorId, record.ownerScopeId);
      const backend = opts.backends[record.backend];
      if (!backend?.computerStatus) throw new Error(`sandbox status unavailable: ${record.backend}`);
      return use(id, () => backend.computerStatus!(record.backingScopeId));
    },
    async restart(actorId, id) {
      await initialize();
      const record = await get(id);
      if (record.state === "retired") throw new Error("sandbox has been retired");
      await authorizeManage(actorId, record.ownerScopeId);
      const backend = opts.backends[record.backend];
      if (!backend?.restartComputer) throw new Error(`sandbox restart unavailable: ${record.backend}`);
      await use(id, () => backend.restartComputer!(record.backingScopeId), true);
    },
    async resolve(scopeId) {
      await initialize();
      const route = await opts.defaults.get(scopeId);
      return route?.sandboxId ? get(route.sandboxId) : null;
    },
    async list(actorId, scopeId) {
      if (!(await (opts.canReadScope ?? opts.canUseScope)(actorId, scopeId)))
        throw new Error("sandbox access requires permission to read its owning scope");
      await initialize();
      const route = await opts.defaults.get(scopeId);
      const sandboxes: SandboxResource[] = [];
      for (const record of await opts.records.all()) {
        if (!(await (opts.canReadScope ?? opts.canUseScope)(actorId, record.ownerScopeId))) continue;
        const backend = opts.backends[record.backend];
        let availableActions = actionsFor(backend).filter((action) => action !== "create");
        if (record.state === "retired")
          availableActions = (record.cleanupPending || record.error) && backend?.destroyScope ? ["retire"] : [];
        if (!(await (opts.canManageScope ?? opts.canUseScope)(actorId, record.ownerScopeId)))
          availableActions = availableActions.filter((action) => action === "status");
        sandboxes.push({ ...record, availableActions });
      }
      const providers = (Object.entries(opts.backends) as Array<[SandboxBackendName, Sandbox]>)
        .filter(([, backend]) => !!backend)
        .map(([name, backend]) => ({
          name,
          ...(backend.profile.spec ? { spec: backend.profile.spec } : {}),
          actions: actionsFor(backend),
        }));
      return {
        sandboxes,
        defaultSandboxId: route?.sandboxId ?? null,
        defaultMode: route?.sandboxId ? "selected" : "none",
        providers,
      };
    },
    async create(actorId, scopeId, backend, name, reservationId) {
      await initialize();
      await authorizeManage(actorId, scopeId);
      await requireActive(scopeId);
      if (!Object.hasOwn(opts.backends, backend) || !opts.backends[backend as SandboxBackendName])
        throw new Error(`sandbox backend unavailable: ${backend}`);
      const id = reservationId ?? randomUUID();
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("invalid sandbox reservation");
      const record: SandboxResource = {
        id,
        backend: backend as SandboxBackendName,
        ownerScopeId: scopeId,
        backingScopeId: `sandbox-${id}`,
        name: name?.trim().slice(0, 120) || backend,
        createdBy: actorId,
        createdAt: new Date().toISOString(),
        legacy: false,
        state: "provisioning",
      };
      return opts.lock.withLock(`project-work:${scopeId}`, () =>
        opts.lock.withLock(`sandbox-resource:${id}`, async () => {
          await requireActive(scopeId);
          await authorizeManage(actorId, scopeId);
          const existing = await opts.records.get(id);
          if (existing) {
            if (existing.ownerScopeId !== scopeId || existing.createdBy !== actorId || existing.backend !== backend)
              throw new Error("sandbox reservation ownership mismatch");
            if (existing.state === "ready") return existing;
            if (existing.state === "retired") throw new Error("sandbox reservation is retired");
          }
          await opts.records.put(id, record);
          const sandbox = opts.backends[record.backend]!;
          try {
            const handle = await sandbox.provision(
              [{ scopeId: record.backingScopeId, mountPath: "/", mode: "rw" }],
              await opts.provisionOptions?.(scopeId),
            );
            const ready: SandboxResource = {
              ...record,
              state: "ready",
              machineId: handle.id,
              spec: sandbox.profile.spec,
            };
            await opts.records.put(id, ready);
            return ready;
          } catch (error) {
            opts.onLifecycleError?.(record, error);
            await opts.records.put(id, {
              ...record,
              state: "failed",
              error: redactSecrets(errMessage(error)),
            });
            throw error;
          }
        }),
      );
    },
    async setDefault(actorId, scopeId, id) {
      await initialize();
      await authorizeManage(actorId, scopeId);
      if (id !== null) await requireActive(scopeId);
      await opts.lock.withLock(`sandbox-default:${scopeId}`, async () => {
        if (id !== null) {
          const record = await get(id);
          await authorize(actorId, record.ownerScopeId);
          if (record.state === "retired" || record.executionBlocked)
            throw new Error("sandbox has been retired or retirement is pending");
          if (record.ownerScopeId !== scopeId)
            throw new Error(
              "the default sandbox must belong to this scope; use sandbox_id for another authorized scope",
            );
        }
        await opts.beforeDefaultChange?.(scopeId);
        await opts.defaults.put(scopeId, { sandboxId: id });
      });
    },
  };
}
