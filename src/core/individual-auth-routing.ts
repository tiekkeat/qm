import {
  codexProviderModelId,
  codexSubscriptionModelId,
  CODEX_SUBSCRIPTION_PROVIDER,
  DEFAULT_AGENT_MODEL_ID,
  DEFAULT_CODEX_MODEL_ID,
  defaultModel,
  defaultModelForHarness,
  defaultModelForProvider,
  resolveModel,
  isOverlayModel,
  modelUnavailableReason,
  modelRequestOverrides,
  type ModelProvider,
  type HarnessId,
} from "../model/pi-models.ts";
import type { UserModelCredential, UserModelCredentialStore } from "../model/user-model-credential-store.ts";
import type { ProviderKeys } from "../model/model-runtime.ts";

export type IndividualAuthRouting =
  | { kind: "apikey"; provider: ModelProvider; harness: "pi"; model: string | undefined; apiKey: string }
  | { kind: "oauth"; provider: "anthropic"; harness: "claude"; model: string }
  | { kind: "oauth"; provider: "openai"; harness: "codex"; model: string }
  | { kind: "oauth"; provider: "openai"; harness: "pi"; model: string }
  | null;

export function personalSubscriptionHarnesses(
  anthropic: UserModelCredential | null,
  openai: UserModelCredential | null,
): HarnessId[] {
  return [
    ...(anthropic?.kind === "oauth" && anthropic.oauth ? ["claude" as const] : []),
    ...(openai?.kind === "oauth" && openai.oauth ? ["pi" as const, "codex" as const] : []),
  ];
}

export function resolveIndividualAuthRouting(
  anthCred: UserModelCredential | null,
  oaiCred: UserModelCredential | null,
  requestedModel: string | undefined,
  preferredHarness?: string,
): IndividualAuthRouting {
  if (requestedModel && (modelUnavailableReason(requestedModel) || !resolveModel(requestedModel))) return null;
  const rawProvider = requestedModel ? resolveModel(requestedModel)?.provider : undefined;
  const requestedProvider = rawProvider === CODEX_SUBSCRIPTION_PROVIDER ? "openai" : rawProvider;
  const pick = ((): { provider: "anthropic" | "openai"; cred: UserModelCredential } | null => {
    if (requestedProvider === "anthropic" && anthCred) return { provider: "anthropic", cred: anthCred };
    if (requestedProvider === "openai" && oaiCred) return { provider: "openai", cred: oaiCred };
    if (anthCred) return { provider: "anthropic", cred: anthCred };
    if (oaiCred) return { provider: "openai", cred: oaiCred };
    return null;
  })();
  if (!pick) return null;
  if (
    requestedModel &&
    modelRequestOverrides(requestedModel) &&
    (pick.provider !== requestedProvider || pick.cred.kind !== "apikey")
  )
    return null;
  if (
    requestedModel &&
    isOverlayModel(requestedModel) &&
    (pick.cred.kind !== "apikey" || requestedProvider !== pick.provider)
  )
    return null;
  if (pick.cred.kind === "apikey" && rawProvider === CODEX_SUBSCRIPTION_PROVIDER) return null;
  if (pick.cred.kind === "apikey" && pick.cred.apiKey) {
    return {
      kind: "apikey",
      provider: pick.provider,
      harness: "pi",
      apiKey: pick.cred.apiKey,
      model:
        requestedModel && requestedProvider === pick.provider ? requestedModel : defaultModelForProvider(pick.provider),
    };
  }
  if (pick.cred.kind === "oauth" && pick.cred.oauth) {
    if (pick.provider === "anthropic") {
      return {
        kind: "oauth",
        provider: "anthropic",
        harness: "claude",
        model:
          requestedModel && requestedProvider === "anthropic" ? requestedModel : defaultModel(DEFAULT_AGENT_MODEL_ID),
      };
    }
    if (preferredHarness === "pi") {
      return {
        kind: "oauth",
        provider: "openai",
        harness: "pi",
        model: codexSubscriptionModelId(
          requestedModel && requestedProvider === "openai" ? requestedModel : DEFAULT_CODEX_MODEL_ID,
        ),
      };
    }
    return {
      kind: "oauth",
      provider: "openai",
      harness: "codex",
      model:
        requestedModel && requestedProvider === "openai"
          ? codexProviderModelId(requestedModel)
          : defaultModelForHarness("codex", DEFAULT_CODEX_MODEL_ID),
    };
  }
  return null;
}

export async function loadPersonalModelAuth(
  credentials: UserModelCredentialStore,
  actorId: string,
  account: string,
  requestedModel: string | undefined,
): Promise<{ keys: ProviderKeys; modelId: string | undefined; subscription?: "anthropic" | "openai" } | undefined> {
  if (account === "shared-openai") {
    const derived = await credentials.sharedOAuth(actorId);
    if (!derived) return undefined;
    const modelId = codexSubscriptionModelId(requestedModel ?? DEFAULT_CODEX_MODEL_ID);
    if (resolveModel(modelId)?.provider !== CODEX_SUBSCRIPTION_PROVIDER) return undefined;
    return { keys: { [CODEX_SUBSCRIPTION_PROVIDER]: derived.accessToken }, modelId, subscription: "openai" };
  }
  const [anthCred, oaiCred] = await Promise.all([
    account === "openai" ? null : credentials.get(actorId, "anthropic"),
    account === "anthropic" ? null : credentials.get(actorId, "openai"),
  ]);
  const routing = resolveIndividualAuthRouting(anthCred ?? null, oaiCred ?? null, requestedModel, "pi");
  if (routing?.kind === "apikey") return { keys: { [routing.provider]: routing.apiKey }, modelId: routing.model };
  if (routing?.kind !== "oauth") return undefined;
  const derived = await credentials.derivedOAuth(actorId, routing.provider);
  if (!derived) return undefined;
  return routing.provider === "anthropic"
    ? {
        keys: { anthropic: derived.accessToken },
        modelId: routing.model,
        subscription: "anthropic",
      }
    : {
        keys: { [CODEX_SUBSCRIPTION_PROVIDER]: derived.accessToken },
        modelId: routing.model,
        subscription: "openai",
      };
}
