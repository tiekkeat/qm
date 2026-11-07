import type { ModelAccount } from "../resolution/config-store.ts";
import { personalSubscriptionHarnesses, resolveIndividualAuthRouting } from "../core/individual-auth-routing.ts";
import { swallow } from "../util/errors.ts";
import { GENERIC_FAILURE_CLAUSE } from "../../plugins/chassis/src/failure-copy.ts";
import { conversationScope } from "../resolution/resolution-service.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";
import type { TurnRuntimePurpose } from "../resolution/config-store.ts";
import { resolveRuntimeChoice } from "../agent/runtime-choice.ts";
import { gatewayModelCatalog } from "../model/gateway-models.ts";
import type { AppDeps } from "./app-types.ts";
import type { ScopeId, TurnRequest } from "../types.ts";
import { orgScope } from "../config.ts";
import {
  defaultModel,
  isHarnessId,
  modelProviderAvailabilityFor,
  modelSupportedByHarness,
  thinkingLevelsForHarness,
  type HarnessId,
  serviceableModelIds,
  ALL_PROVIDERS_AVAILABLE,
  fastModeModelIds,
  modelCatalogFor,
  modelOfferedInWebui,
  modelUnavailableReason,
  thinkingLevelsFor,
  codexProviderModelId,
  codexSubscriptionModelId,
  companyModelId,
  defaultWebuiModelIds,
  THINKING_LEVELS,
  modelServiceable,
  resolveModel,
  type ModelProviderAvailability,
} from "../model/pi-models.ts";
import { builtInModelCatalog, selectableCatalog, selectableModelCatalog } from "../model/model-catalog.ts";
import type { RuntimeChoice } from "../agent/agent.ts";
import { modelBilling } from "../model/model-route.ts";

export type RuntimeDeps = Partial<
  Pick<
    AppDeps,
    "config" | "providerKeys" | "modelCredentials" | "modelCredentialFetch" | "refreshModels" | "userModelCredentials"
  >
> & { baseModelDefault?: string; harnessId?: HarnessId };

export function runtimeFallback(ctx: { deps: RuntimeDeps }): RuntimeChoice & { harnessId: HarnessId } {
  const gatewayIds = gatewayModelCatalog(true).map((model) => model.id);
  const providers =
    gatewayIds.length && ctx.deps.providerKeys
      ? { ...ctx.deps.providerKeys, modelIds: new Set(gatewayIds) }
      : undefined;
  return {
    harnessId: ctx.deps.harnessId ?? "pi",
    modelId: ctx.deps.baseModelDefault ?? defaultModel(undefined, providers),
  };
}

export async function userRuntimeConfigBody(
  ctx: { deps: RuntimeDeps },
  scope: ScopeId,
  actorId: string,
  options: { account?: ModelAccount; purpose?: TurnRuntimePurpose; requested?: Partial<RuntimeChoice> } = {},
) {
  const account = options.account ?? (await ctx.deps.config?.getModelAccountDurable(actorId));
  const store = ctx.deps.userModelCredentials;
  if (!store || !account || account === "company")
    return runtimeConfigBody(ctx, scope, undefined, options.purpose, options.requested);
  if (account === "shared-openai") {
    const shared = await store.sharedStatus();
    const available = (await store.hasSharedGrant(actorId)) && shared.connected && !shared.needsReconnect;
    const credential = available ? ({ provider: "openai", kind: "oauth", oauth: {}, updatedAt: 0 } as const) : null;
    const snapshot = await runtimeConfigBody(
      ctx,
      scope,
      async (choice) => {
        const route = resolveIndividualAuthRouting(null, credential, choice.modelId, "codex");
        return route && route.harness === choice.harnessId && route.model === choice.modelId
          ? null
          : "account_runtime_unavailable";
      },
      options.purpose,
      options.requested,
      available ? ["codex"] : [],
    );
    const route = resolveIndividualAuthRouting(null, credential, snapshot.effective.modelId, "codex");
    return route?.model && snapshot.modelsByHarness[route.harness]?.includes(route.model)
      ? { ...snapshot, effective: { ...snapshot.effective, harnessId: route.harness, modelId: route.model } }
      : snapshot;
  }
  const [anthropic, openai] = await Promise.all([
    account === "openai" ? null : store.get(actorId, "anthropic"),
    account === "anthropic" ? null : store.get(actorId, "openai"),
  ]);
  const subscriptionHarnesses = personalSubscriptionHarnesses(anthropic, openai);
  const approved = (await ctx.deps.config!.getApprovedHarnessesDurable()) ?? [runtimeFallback(ctx).harnessId];
  const snapshot = await runtimeConfigBody(
    ctx,
    scope,
    async (choice) => {
      const route = resolveIndividualAuthRouting(anthropic, openai, choice.modelId, choice.harnessId);
      if (!route || route.harness !== choice.harnessId || route.model !== choice.modelId)
        return "account_runtime_unavailable";
      if (
        route.kind === "apikey" &&
        subscriptionHarnesses.length > 0 &&
        (!approved.includes(choice.harnessId ?? "pi") || !(await webuiModelEnabled(ctx, choice.modelId)))
      )
        return "account_runtime_unavailable";
      return null;
    },
    options.purpose,
    options.requested,
    subscriptionHarnesses,
  );
  const route = resolveIndividualAuthRouting(
    anthropic,
    openai,
    snapshot.effective.modelId,
    snapshot.effective.harnessId,
  );
  if (!route?.model || !snapshot.modelsByHarness[route.harness]?.includes(route.model)) return snapshot;
  const { unavailableReason: _, ...available } = snapshot;
  return {
    ...available,
    effective: {
      ...snapshot.effective,
      harnessId: route.harness,
      modelId: route.model,
      effortLevel: thinkingLevelsFor(route.model).includes(snapshot.effective.effortLevel ?? "auto")
        ? snapshot.effective.effortLevel
        : "auto",
      fastMode: snapshot.effective.fastMode === true && fastModeModelIds().includes(route.model),
    },
  };
}

function storedChoice(stored: Omit<RuntimeChoice, "harnessId"> & { harnessId?: string }): RuntimeChoice {
  return {
    harnessId: isHarnessId(stored.harnessId) ? stored.harnessId : "pi",
    modelId: stored.modelId,
    ...(stored.effortLevel ? { effortLevel: stored.effortLevel } : {}),
    ...(typeof stored.fastMode === "boolean" ? { fastMode: stored.fastMode } : {}),
  };
}

export async function runtimeConfigBody(
  ctx: { deps: RuntimeDeps },
  scope: ScopeId,
  authorizeChoice?: (choice: RuntimeChoice) => Promise<string | null>,
  purpose?: TurnRuntimePurpose,
  requested?: Partial<RuntimeChoice>,
  subscriptionHarnesses: readonly HarnessId[] = [],
) {
  if (authorizeChoice)
    ctx = { deps: { ...ctx.deps, providerKeys: ALL_PROVIDERS_AVAILABLE, modelCredentials: undefined } };
  const config = ctx.deps.config!;
  const configuredKeys = ctx.deps.providerKeys ?? ALL_PROVIDERS_AVAILABLE;
  const managedKeys = ctx.deps.modelCredentials ? await ctx.deps.modelCredentials.availability() : configuredKeys;
  const fallback = runtimeFallback(ctx);
  const org = orgScope();
  const approvedHarnesses = [
    ...new Set([
      ...((await config.getApprovedHarnessesDurable()) ?? [fallback.harnessId]).filter(isHarnessId),
      ...subscriptionHarnesses,
    ]),
  ];
  const providersFor = (harnessId: string) => modelProviderAvailabilityFor(harnessId, configuredKeys, managedKeys);
  const catalog =
    ctx.deps.modelCredentials && managedKeys.openrouter
      ? await selectableModelCatalog(ctx.deps.modelCredentialFetch)
      : builtInModelCatalog();
  const orgStored = await config.getRuntimeSelectionDurable(org);
  const orgLegacyModel = orgStored ? null : await config.getBaseModelOwnDurable(org);
  let orgDefault: RuntimeChoice & { revision: number } = { ...fallback, revision: orgStored?.revision ?? 0 };
  if (orgStored) orgDefault = { ...storedChoice(orgStored), revision: orgStored.revision ?? 0 };
  else if (orgLegacyModel) orgDefault = { modelId: orgLegacyModel, revision: 0 };
  const stored = scope === org ? orgStored : await config.getRuntimeSelectionDurable(scope);
  const legacyModel = scope === org ? null : await config.getBaseModelOwnDurable(scope);
  let scopeOverride: {
    harnessId: HarnessId;
    modelId: string;
    effortLevel?: string;
    fastMode?: boolean;
    orgRevision?: number;
  } | null = null;
  if (stored && isHarnessId(stored.harnessId)) {
    scopeOverride = {
      harnessId: stored.harnessId,
      modelId: stored.modelId,
      ...(stored.effortLevel ? { effortLevel: stored.effortLevel } : {}),
      ...(typeof stored.fastMode === "boolean" ? { fastMode: stored.fastMode } : {}),
      orgRevision: stored.orgRevision,
    };
  } else if (legacyModel) {
    scopeOverride = { harnessId: fallback.harnessId, modelId: legacyModel, orgRevision: 0 };
  }
  const purposeDefault = purpose ? await config.getPurposeRuntimeDurable(purpose) : undefined;
  const inherited =
    purposeDefault && isHarnessId(purposeDefault.harnessId)
      ? { ...purposeDefault, harnessId: purposeDefault.harnessId }
      : (scopeOverride ?? orgDefault);
  const effective: RuntimeChoice =
    purpose && !subscriptionHarnesses.length
      ? await resolveRuntimeChoice(config, org, scope, fallback, requested, undefined, purpose)
      : { ...inherited, ...requested };
  const selected = [orgDefault, scopeOverride, effective, purposeDefault].filter((choice) => choice != null);
  const allowlist = await config.getWebuiModelsDurable(org);
  const modelsByHarness = Object.fromEntries(
    approvedHarnesses.map((harnessId) => {
      const harnessAllowlist = subscriptionHarnesses.includes(harnessId) ? null : allowlist;
      const ids =
        harnessAllowlist != null
          ? harnessAllowlist.filter((id) => modelSupportedByHarness(id, harnessId))
          : selectableCatalog(catalog)
              .filter((model) => modelSupportedByHarness(model.id, harnessId))
              .filter((model) => modelOfferedInWebui(model.id))
              .map((model) => model.id);
      for (const choice of selected) {
        if (
          harnessAllowlist?.length !== 0 &&
          (!authorizeChoice ||
            !harnessAllowlist ||
            choice.modelId === orgDefault.modelId ||
            choice.modelId === purposeDefault?.modelId ||
            harnessAllowlist.includes(codexProviderModelId(choice.modelId))) &&
          choice.harnessId === harnessId &&
          modelSupportedByHarness(choice.modelId, harnessId) &&
          !ids.includes(choice.modelId)
        )
          ids.push(choice.modelId);
      }
      return [harnessId, serviceableModelIds(ids, providersFor(harnessId))];
    }),
  );
  if (authorizeChoice) {
    const piModels = modelsByHarness.pi ?? [];
    for (const id of piModels) {
      const subscriptionId = codexSubscriptionModelId(id);
      if (modelSupportedByHarness(subscriptionId, "pi") && !piModels.includes(subscriptionId))
        piModels.push(subscriptionId);
    }
    for (const harnessId of approvedHarnesses) {
      const candidates = modelsByHarness[harnessId] ?? [];
      const allowed = await Promise.all(
        candidates.map((modelId) => authorizeChoice({ harnessId, modelId, effortLevel: "auto", fastMode: false })),
      );
      modelsByHarness[harnessId] = candidates.filter((_, index) => !allowed[index]);
    }
  }
  const models = [...new Set(Object.values(modelsByHarness).flat())];
  const billing = (id: string) =>
    modelBilling(!!managedKeys.modelIds?.has(companyModelId(id, managedKeys)), !!authorizeChoice);
  const modelCatalog = Object.fromEntries(
    Object.entries(modelCatalogFor(new Set(models))).map(([id, meta]) => [id, { ...meta, billing: billing(id) }]),
  );
  return {
    scopeId: scope,
    ...(purpose ? { executionPurpose: purpose } : {}),
    models,
    approvedHarnesses,
    modelsByHarness,
    modelCatalog,
    orgDefault,
    scopeOverride,
    effective: storedChoice(effective),
    ...(!models.includes(effective.modelId)
      ? {
          unavailableReason:
            modelUnavailableReason(effective.modelId) ?? "Selected model is unavailable; choose another model",
        }
      : {}),
    upgradeAvailable: Boolean(scopeOverride && scopeOverride.orgRevision !== orgDefault.revision),
    fastModeModelIds: fastModeModelIds(),
    interactiveFastMode: await config.getInteractiveFastModeDurable(),
  };
}

export function validateRuntimeChoice(choice: RuntimeChoice): string | null {
  if (!isHarnessId(choice.harnessId ?? "pi") || !modelSupportedByHarness(choice.modelId, choice.harnessId ?? "pi"))
    return "model_not_supported";
  if (
    choice.effortLevel !== undefined &&
    !thinkingLevelsForHarness(choice.harnessId ?? "pi", choice.modelId).includes(choice.effortLevel)
  )
    return "effort_not_supported";
  if (choice.fastMode !== undefined && typeof choice.fastMode !== "boolean") return "fast_mode_invalid";
  if (choice.fastMode && !fastModeModelIds().includes(choice.modelId)) return "fast_mode_not_supported";
  return null;
}

export async function webuiModelEnabled(
  ctx: { deps: RuntimeDeps },
  modelId: string,
  purpose?: TurnRuntimePurpose,
): Promise<boolean> {
  modelId = codexProviderModelId(modelId);
  const config = ctx.deps.config!;
  const picker = await config.getWebuiModelsDurable(orgScope());
  if (picker == null || picker.includes(modelId)) return true;
  if (picker.length === 0) return false;
  const org = orgScope();
  const stored = await config.getRuntimeSelectionDurable(org);
  const orgModel = stored?.modelId ?? (await config.getBaseModelOwnDurable(org)) ?? runtimeFallback(ctx).modelId;
  const purposeModel = purpose ? (await config.getPurposeRuntimeDurable(purpose))?.modelId : undefined;
  return modelId === orgModel || modelId === purposeModel;
}

export async function availableRuntimeError(
  ctx: { deps: RuntimeDeps },
  scope: ScopeId,
  choice: RuntimeChoice,
  purpose?: TurnRuntimePurpose,
  actorId?: string,
  account?: ModelAccount,
): Promise<string | null> {
  await ctx.deps.refreshModels?.();
  const personal = actorId && (account ?? (await ctx.deps.config?.getModelAccountDurable(actorId))) !== "company";
  const choices = personal
    ? await userRuntimeConfigBody(ctx, scope, actorId, { account, purpose, requested: choice })
    : await runtimeConfigBody(ctx, scope, undefined, purpose, choice);
  if (
    !choices.modelsByHarness[choice.harnessId ?? "pi"]?.includes(choice.modelId) ||
    (!personal && !(await webuiModelEnabled(ctx, choice.modelId, purpose)))
  )
    return "runtime is no longer available or enabled on this deployment";
  return validateRuntimeChoice({
    ...choice,
    effortLevel: choice.effortLevel === "adaptive" || choice.effortLevel === "default" ? choice.effortLevel : undefined,
  });
}

export async function requestedRuntimeError(
  ctx: { deps: RuntimeDeps },
  scope: ScopeId,
  requested: Partial<RuntimeChoice>,
  purpose?: TurnRuntimePurpose,
): Promise<string | null> {
  const { effective } = await runtimeConfigBody(ctx, scope, undefined, purpose, requested).catch((error: unknown) => {
    if (!(error instanceof NonRetryableTurnError)) throw error;
    return runtimeConfigBody(ctx, scope, undefined, purpose);
  });
  return availableRuntimeError(
    ctx,
    scope,
    {
      ...requested,
      modelId: requested.modelId ?? effective.modelId,
    },
    purpose,
  );
}

export function validateWebTurnModelOptions(
  input: { model?: string; thinkingLevel?: string },
  enabledModels: readonly string[] | null,
  providers: ModelProviderAvailability = ALL_PROVIDERS_AVAILABLE,
): string | null {
  const enabled = enabledModels ?? defaultWebuiModelIds();
  const allowedModels = serviceableModelIds(enabled, providers);
  if (input.model && !allowedModels.includes(input.model)) {
    return resolveModel(input.model) && !modelServiceable(input.model, providers)
      ? "that model isn't available on this deployment (its provider isn't configured)"
      : "that model is not enabled for the web UI";
  }
  if (input.thinkingLevel && !(THINKING_LEVELS as readonly string[]).includes(input.thinkingLevel))
    return "unsupported thinking level";
  return null;
}

async function webuiModels(
  deps: AppDeps,
  orgModelId: string,
  providers: ModelProviderAvailability | undefined,
): Promise<string[] | null> {
  const configured = await deps.config.getWebuiModelsDurable(orgScope());
  if (configured != null) return configured.length ? [...new Set([...configured, orgModelId])] : [];
  if (!providers?.openrouter) return null;
  const offered = selectableCatalog(await selectableModelCatalog(deps.modelCredentialFetch))
    .filter((model) => modelOfferedInWebui(model.id))
    .map((model) => model.id);
  return [...new Set([...offered, orgModelId])];
}

export async function turnModelRefusal(
  deps: AppDeps,
  req: TurnRequest,
  actorId: string,
  individualAuth: boolean,
  purpose: TurnRuntimePurpose | undefined,
): Promise<string | null> {
  const org = orgScope();
  const scope = conversationScope(req.conversation, actorId);
  const requested: Partial<RuntimeChoice> = {
    ...(isHarnessId(req.harness) ? { harnessId: req.harness } : {}),
    ...(req.model ? { modelId: req.model } : {}),
    ...(req.thinkingLevel ? { effortLevel: req.thinkingLevel } : {}),
    ...(typeof req.fastMode === "boolean" ? { fastMode: req.fastMode } : {}),
  };
  if (req.origin?.kind === "automation" && req.model) {
    const error = individualAuth
      ? await (async () => {
          const snapshot = await userRuntimeConfigBody({ deps }, scope, actorId, { purpose, requested });
          return availableRuntimeError({ deps }, scope, { ...snapshot.effective, ...requested }, purpose, actorId);
        })()
      : await requestedRuntimeError({ deps }, scope, requested, purpose);
    if (error) return error;
  }
  if (req.surface !== "web") return null;
  if (individualAuth) {
    if (!req.model) return null;
    const available = await userRuntimeConfigBody({ deps }, scope, actorId);
    if (!available.modelsByHarness[req.harness ?? available.effective.harnessId ?? "pi"]?.includes(req.model))
      return "Your connected AI account cannot serve this model.";
    return validateWebTurnModelOptions(req, available.models);
  }
  const fallback = deps.runtimeFallback ?? { modelId: defaultModel() };
  const providers = deps.modelCredentials
    ? await deps.modelCredentials.availability()
    : (deps.providerKeys ?? deps.modelProviders);
  const hydrate = async () =>
    deps.modelCredentials && providers?.openrouter ? selectableModelCatalog(deps.modelCredentialFetch) : undefined;
  const storedOrg = await deps.config.getRuntimeSelectionDurable(org);
  let orgModelId: string;
  let runtime: RuntimeChoice;
  try {
    const orgModel = storedOrg?.modelId ?? (await deps.config.getBaseModelOwnDurable(org)) ?? fallback.modelId;
    orgModelId = modelUnavailableReason(orgModel)
      ? orgModel
      : (await resolveRuntimeChoice(deps.config, org, org, fallback, undefined, hydrate)).modelId;
    runtime = await resolveRuntimeChoice(deps.config, org, scope, fallback, requested, hydrate, purpose);
  } catch (error) {
    swallow("turn: runtime resolution", error);
    return `I couldn't set up that runtime choice — ${GENERIC_FAILURE_CLAUSE}`;
  }
  if (providers && !modelServiceable(runtime.modelId, providers))
    return "that model isn't available on this deployment (its provider isn't configured)";
  return validateWebTurnModelOptions(req, await webuiModels(deps, orgModelId, providers), providers);
}
