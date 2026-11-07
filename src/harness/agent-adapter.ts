import type { Agent, AgentTurnInput } from "../agent/agent.ts";
import type { Harness, HarnessTurnInput } from "./harness.ts";
import { defineHarness } from "./harness.ts";
import { itemNativeEntry, nativeEntryItem, nativeHistoryItem } from "./transcript.ts";
import { storedItem } from "../sessions/items.ts";
import type { HarnessId } from "../model/pi-models.ts";

const sourceTurn = Symbol("sourceAgentTurn");
type NativeTurn = HarnessTurnInput & { [sourceTurn]?: AgentTurnInput };

export function harnessAgent(harness: Harness): Agent {
  return {
    ...harness.models,
    contextTokenBudget: (model) => harness.models.contextTokenBudget?.(undefined, model),
    shouldRespond: harness.models.shouldRespond
      ? (input) =>
          harness.models.shouldRespond!({
            ...input,
            history: input.history.map((item) => itemNativeEntry(item, input.session.scopeId)),
          })
      : undefined,
    compactHistory: harness.models.compactHistory
      ? (input) =>
          harness.models.compactHistory!({
            ...input,
            history: input.history.map((item) => itemNativeEntry(item, input.session.scopeId)),
          })
      : undefined,
    async runTurn(input) {
      const native: NativeTurn = {
        ...input,
        [sourceTurn]: input,
        history: input.history.map((item) => itemNativeEntry(item, input.scopeLabel)),
        emit: async (entry) => itemNativeEntry(await input.emit(nativeEntryItem(entry)), input.scopeLabel),
      };
      return harness.turns.runTurn(native);
    },
    close: () => harness.turns.close?.(),
  };
}

export function agentHarness(agent: Agent, id: HarnessId = "pi"): Harness {
  return defineHarness(
    {
      id,
      controlTransport: "in-process",
      toolTransport: "in-process",
      transcriptFormat: "items",
      capabilities: new Set(["abort", "steer", "images", "thinking-level", "fast-mode", "goal-enforcement"]),
    },
    {
      ...agent,
      contextTokenBudget: (_scope, model) => agent.contextTokenBudget?.(model),
      shouldRespond: agent.shouldRespond
        ? (input) => agent.shouldRespond!({ ...input, history: input.history.map(nativeHistoryItem) })
        : undefined,
      compactHistory: agent.compactHistory
        ? (input) => agent.compactHistory!({ ...input, history: input.history.map(nativeHistoryItem) })
        : undefined,
      async runTurn(input: NativeTurn) {
        return agent.runTurn({
          ...input[sourceTurn],
          ...input,
          history: input.history.map(nativeHistoryItem),
          emit: async (item) => {
            const translated = itemNativeEntry(
              storedItem(item, { sessionId: input.session.id, seq: 0, createdAt: Date.now() }),
              input.scopeLabel,
            );
            const saved = await input.emit({
              type: translated.type,
              payload: translated.payload,
              scopeLabel: input.scopeLabel,
              original: item,
            });
            return nativeHistoryItem(saved);
          },
        });
      },
    },
  );
}
