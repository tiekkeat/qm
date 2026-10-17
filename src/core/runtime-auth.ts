import type { CodexTurnAuth } from "../harness/harness.ts";
import type { RuntimeChoice } from "../harness/harness.ts";
import type { ProviderKeys } from "../harness/pi-harness.ts";
import { CODEX_SUBSCRIPTION_PROVIDER } from "../model/pi-models.ts";
import { resolveIndividualAuthRouting } from "./individual-auth-routing.ts";
import { NonRetryableTurnError } from "./turn-error.ts";
import type { ModelAccount } from "../resolution/config-store.ts";
import type { ScopeId } from "../types.ts";
import type { OrchestratorDeps } from "./orchestrator/types.ts";

export function createRuntimeAuthLoader(
  deps: Pick<OrchestratorDeps, "userModelCredentials" | "config" | "auditLog" | "defaultHarness">,
  options: {
    actorId: string;
    orgScopeId: ScopeId;
    scopeId: ScopeId;
    threadRef: string;
    external: boolean;
    modelAccount: ModelAccount;
    model?: string;
    harness?: string;
    purposeDefault?: { modelId: string; harnessId: string };
  },
) {
  const { actorId, orgScopeId, scopeId, threadRef, external, modelAccount, model, harness, purposeDefault } = options;
  return async (runtime: Partial<RuntimeChoice>) => {
    let userProviderKeys: ProviderKeys | undefined;
    let userModelOverride: string | undefined;
    let userHarnessOverride: string | undefined;
    let codexTurnAuth: CodexTurnAuth | undefined;
    let claudeOauthToken: string | undefined;
    const userCredStore = external ? undefined : deps.userModelCredentials;
    const account = modelAccount;
    if (userCredStore && account === "shared-openai") {
      const derived = await userCredStore.sharedOAuth(actorId);
      if (!derived?.idToken)
        throw new NonRetryableTurnError(
          "Shared Codex access is unavailable. Ask an administrator to restore your grant or reconnect the account.",
        );
      const routing = resolveIndividualAuthRouting(
        null,
        { provider: "openai", kind: "oauth", oauth: {}, updatedAt: 0 },
        runtime.modelId ?? model ?? purposeDefault?.modelId,
        "codex",
      );
      if (routing?.kind !== "oauth" || routing.provider !== "openai" || routing.harness !== "codex")
        throw new NonRetryableTurnError("The selected model cannot use shared Codex access.");
      codexTurnAuth = {
        accessToken: derived.accessToken,
        idToken: derived.idToken,
        ...(derived.accountId ? { accountId: derived.accountId } : {}),
        ...(derived.expiresAt !== undefined ? { expiresAt: derived.expiresAt } : {}),
      };
      userHarnessOverride = routing.harness;
      userModelOverride = routing.model;
      deps.auditLog.record({
        at: Date.now(),
        principalId: actorId,
        action: "shared-codex.use",
        resource: threadRef,
        scopeLabel: scopeId,
        detail: routing.model,
      });
      return { userProviderKeys, userModelOverride, userHarnessOverride, claudeOauthToken, codexTurnAuth };
    }
    if (userCredStore && account !== "company") {
      const [anthCred, oaiCred] = await Promise.all([
        account === "openai" ? null : userCredStore.get(actorId, "anthropic"),
        account === "anthropic" ? null : userCredStore.get(actorId, "openai"),
      ]);
      const orgRuntime = await deps.config?.getRuntimeSelectionDurable(orgScopeId);
      const preferredHarness =
        runtime.harnessId ?? harness ?? purposeDefault?.harnessId ?? orgRuntime?.harnessId ?? deps.defaultHarness;
      const routing = resolveIndividualAuthRouting(
        anthCred ?? null,
        oaiCred ?? null,
        runtime.modelId ?? model ?? purposeDefault?.modelId,
        preferredHarness,
      );
      if (routing?.kind === "apikey") {
        userHarnessOverride = "pi";
        userProviderKeys = { [routing.provider]: routing.apiKey };
        userModelOverride = routing.model;
      } else if (routing?.kind === "oauth" && routing.provider === "anthropic" && anthCred?.oauth) {
        const derived = await userCredStore.derivedOAuth(actorId, "anthropic");
        if (derived) {
          claudeOauthToken = derived.accessToken;
          userHarnessOverride = routing.harness;
          userModelOverride = routing.model;
        }
      } else if (
        routing?.kind === "oauth" &&
        routing.provider === "openai" &&
        routing.harness === "pi" &&
        oaiCred?.oauth
      ) {
        const derived = await userCredStore.derivedOAuth(actorId, "openai");
        if (derived) {
          userProviderKeys = { [CODEX_SUBSCRIPTION_PROVIDER]: derived.accessToken };
          userHarnessOverride = routing.harness;
          userModelOverride = routing.model;
        }
      } else if (routing?.kind === "oauth" && routing.provider === "openai" && oaiCred?.oauth) {
        const derived = await userCredStore.derivedOAuth(actorId, "openai");
        if (derived?.idToken) {
          codexTurnAuth = {
            accessToken: derived.accessToken,
            idToken: derived.idToken,
            ...(derived.accountId ? { accountId: derived.accountId } : {}),
            ...(derived.expiresAt !== undefined ? { expiresAt: derived.expiresAt } : {}),
          };
          userHarnessOverride = routing.harness;
          userModelOverride = routing.model;
        }
      }
      if (!userHarnessOverride) {
        throw new NonRetryableTurnError(
          "Your personal AI account is unavailable. Open Settings → AI access to reconnect Claude or ChatGPT / Codex, or choose company access. The chat cannot continue on company access.",
        );
      }
    }
    return { userProviderKeys, userModelOverride, userHarnessOverride, claudeOauthToken, codexTurnAuth };
  };
}
