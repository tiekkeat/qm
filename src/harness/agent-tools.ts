import {
  createAgentTools as currentTools,
  coreToolOptions as currentOptions,
  type ToolContextRef as CurrentRef,
  type AgentToolsOptions as CurrentOptions,
} from "../agent/agent-tools.ts";
import type { Config } from "../config.ts";
import type { NewEntry, SessionEntry } from "./transcript.ts";
import { nativeHistoryItem, itemNativeEntry } from "./transcript.ts";
import { storedItem, type NewItem } from "../sessions/items.ts";
import type { McpToolDescriptor } from "../mcp/mcp-tool-service.ts";

export interface ToolContextRef extends Omit<CurrentRef, "emit" | "goalRecentWork"> {
  runtimeRunId?: string;
  emit?: (entry: NewEntry) => Promise<SessionEntry | undefined>;
  goalRecentWork?: () => string;
}
export interface AgentToolsOptions extends Omit<CurrentOptions, "mcpTools"> {
  commandCredentialHandles?: readonly string[];
  scratchExec?: boolean;
  ownerAuthExec?: boolean;
  reachExec?: boolean;
  mcpTools?: () => McpToolDescriptor[];
}
export const coreToolOptions = (config: Config): AgentToolsOptions => {
  const { mcpTools: _mcpTools, ...options } = currentOptions(config);
  return options;
};
export function createAgentTools(ref: ToolContextRef, opts: AgentToolsOptions = {}) {
  const adapter = new Proxy(ref, {
    get(target, key, receiver) {
      if (key !== "emit") return Reflect.get(target, key, receiver);
      if (!target.emit) return undefined;
      return async (item: NewItem) => {
        const scopeLabel = target.scopeLabel!;
        const translated = itemNativeEntry(
          storedItem(item, { sessionId: "", seq: 0, createdAt: Date.now() }),
          scopeLabel,
        );
        const entry = await target.emit!({
          type: translated.type,
          payload: translated.payload,
          scopeLabel,
          original: item,
        });
        return entry ? nativeHistoryItem(entry) : undefined;
      };
    },
  }) as unknown as CurrentRef;
  return currentTools(adapter, { ...opts, mcpTools: opts.mcpTools?.() });
}
