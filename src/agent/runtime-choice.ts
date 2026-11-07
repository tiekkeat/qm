import { resolveRuntimeChoiceDurable as resolveHarnessRuntimeChoice } from "../harness/harness-router.ts";
import type { ScopedConfigStore, TurnRuntimePurpose } from "../resolution/config-store.ts";
import { safeModelMetadata } from "../model/pi-models.ts";
import type { ScopeId } from "../types.ts";
import type { Agent, AgentTurnInput, CompactInput, RuntimeChoice, SessionRoute } from "./agent.ts";
import { governGoal, type GoalGovernorInput } from "./goal.ts";
import { infrequentCronTurn, turnRuntimePurpose, NON_INTERACTIVE_FAST_MODE, NON_INTERACTIVE_THINKING_LEVEL } from "../core/turn-options.ts";

export { NON_INTERACTIVE_FAST_MODE, NON_INTERACTIVE_THINKING_LEVEL } from "../core/turn-options.ts";

export function turnModelOptions(input: {
  triggered: boolean;
  surface?: string;
  infrequentCron?: boolean;
  thinkingLevel?: string;
  fastMode?: boolean;
}): {
  thinkingLevel?: string;
  fastMode?: boolean;
} {
  const chatDefaults = infrequentCronTurn(input);
  const nonInteractiveDefaults = input.triggered && !chatDefaults && turnRuntimePurpose(input) !== "cron";
  let thinkingLevel = input.thinkingLevel;
  if (!thinkingLevel && nonInteractiveDefaults) thinkingLevel = NON_INTERACTIVE_THINKING_LEVEL;
  let fastMode = input.fastMode;
  if (typeof fastMode !== "boolean" && (nonInteractiveDefaults || chatDefaults)) fastMode = NON_INTERACTIVE_FAST_MODE;
  return {
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
  };
}

export async function resolveRuntimeChoice(
  config: ScopedConfigStore,
  orgScopeId: ScopeId,
  scope: ScopeId,
  fallback: RuntimeChoice,
  requested?: Partial<RuntimeChoice>,
  hydrateModelCatalog?: () => Promise<unknown>,
  purpose?: TurnRuntimePurpose,
): Promise<RuntimeChoice> {
  return resolveHarnessRuntimeChoice(
    config,
    orgScopeId,
    purpose === "infrequentCron" ? orgScopeId : scope,
    { ...fallback, harnessId: fallback.harnessId ?? "pi" },
    requested,
    hydrateModelCatalog,
    purpose === "infrequentCron" ? undefined : purpose,
  );
}

export function withResolvedRuntime(
  agent: Agent,
  resolve: (input: AgentTurnInput, routedBy: (ruleId: string) => void) => RuntimeChoice | Promise<RuntimeChoice>,
  resolveSession: (route: SessionRoute) => Promise<RuntimeChoice>,
): Agent {
  const compactHistory = agent.compactHistory?.bind(agent);
  return {
    ...agent,
    ...(compactHistory
      ? {
          async compactHistory(input: CompactInput) {
            return compactHistory({ ...input, runtime: await resolveSession(input) });
          },
        }
      : {}),
    async runTurn(input) {
      let routedBy: string | undefined;
      const choice = await resolve(input, (ruleId) => {
        routedBy = ruleId;
      });
      const label = safeModelMetadata(choice.modelId)?.label;
      input.onRuntime?.({
        modelId: choice.modelId,
        ...(label ? { label } : {}),
        ...(routedBy ? { change: { rule: routedBy } } : {}),
      });
      const judge = agent.judge;
      return agent.runTurn({
        ...input,
        runtime: choice,
        tools: input.runtimeControl
          ? { ...input.tools, runtime: (request, signal) => input.runtimeControl!(choice, request, signal) }
          : input.tools,
        ...(judge ? { governGoal: (goalInput: GoalGovernorInput) => governGoal(judge, goalInput, input.cancel) } : {}),
      });
    },
  };
}
