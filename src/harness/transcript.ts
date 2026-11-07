import type { ScopeId } from "../types.ts";
import { storedItem, type Item, type NewItem } from "../sessions/items.ts";

export type EntryType =
  | "user"
  | "assistant"
  | "thinking"
  | "text_start"
  | "text"
  | "tool_call"
  | "tool_result"
  | "soul"
  | "system"
  | "delivery"
  | "approval_request"
  | "approval_resolved";
export interface NewEntry {
  type: EntryType;
  payload: unknown;
  scopeLabel: ScopeId;
  original?: NewItem;
}
export interface SessionEntry extends NewEntry {
  sessionId: string;
  seq: number;
  parentSeq: number | null;
  createdAt: number;
  original?: Item;
}
export interface GapWork {
  phase: string;
  start: number;
  end: number;
  tool?: string;
}
export type GapPhases = Record<string, number | undefined>;

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const string = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

export function nativeEntryItem(entry: NewEntry): NewItem {
  if (entry.original) return entry.original;
  const body = object(entry.payload);
  const text = string(body.text);
  switch (entry.type) {
    case "user":
      return { kind: body.steered ? "SteeringMessage" : "UserMessage", text, externalId: string(body.ts), body };
    case "assistant":
      return { kind: "AgentMessage", text, body };
    case "thinking":
      return { kind: "Reasoning", text: string(body.thinking) ?? text, body };
    case "text_start":
    case "text":
      return { kind: "AgentMessage", variant: "narration", text, body };
    case "tool_call":
    case "tool_result": {
      const callId = string(body.callId);
      if (!callId) throw new Error("Native tool record has no call ID");
      return {
        kind: entry.type === "tool_call" ? "ToolCall" : "ToolResult",
        callId,
        tool: string(body.tool),
        text: text ?? string(body.result) ?? string(body.stdout),
        isError: body.ok === false || body.isError === true,
        body,
      };
    }
    case "delivery":
      return { kind: "AgentMessage", variant: "files_delivered", text, body };
    case "system": {
      if (body.kind === "turn_stopped") return { kind: "Stop", text, body };
      if (body.kind === "context_compaction")
        return {
          kind: "ContextCompaction",
          text,
          throughSeq: typeof body.throughSeq === "number" ? body.throughSeq : undefined,
          body,
        };
      return { kind: "Wake", wakeCause: "system", text, body };
    }
    case "soul":
      return { kind: "Wake", wakeCause: "system", text, body };
    case "approval_request":
    case "approval_resolved": {
      const elicitId = string(body.requestId) ?? string(body.id);
      if (!elicitId) throw new Error("Native approval record has no request ID");
      return { kind: entry.type === "approval_request" ? "Elicitation" : "ElicitationResponse", elicitId, body };
    }
  }
}

export function nativeHistoryItem(entry: SessionEntry): Item {
  return (
    entry.original ??
    storedItem(nativeEntryItem(entry), { sessionId: entry.sessionId, seq: entry.seq, createdAt: entry.createdAt })
  );
}

export function itemNativeEntry(item: Item, scopeLabel: ScopeId): SessionEntry {
  let type: EntryType = "system";
  switch (item.kind) {
    case "UserMessage":
    case "SteeringMessage":
      type = "user";
      break;
    case "AgentMessage":
      type = "assistant";
      if (item.variant === "narration") type = "text";
      else if (item.variant === "files_delivered") type = "delivery";
      break;
    case "Reasoning":
      type = "thinking";
      break;
    case "ToolCall":
      type = "tool_call";
      break;
    case "ToolResult":
      type = "tool_result";
      break;
    case "Elicitation":
      type = "approval_request";
      break;
    case "ElicitationResponse":
      type = "approval_resolved";
      break;
  }
  return {
    type,
    sessionId: item.sessionId,
    seq: item.seq,
    parentSeq: null,
    createdAt: item.createdAt,
    scopeLabel,
    original: item,
    payload: {
      ...item.body,
      ...(item.text !== null ? { text: item.text } : {}),
      ...(item.kind === "Reasoning" ? { thinking: item.text } : {}),
      ...(item.callId ? { callId: item.callId } : {}),
      ...(item.tool ? { tool: item.tool } : {}),
      ...(item.externalId ? { ts: item.externalId } : {}),
      ...(item.kind === "SteeringMessage" ? { steered: true } : {}),
    },
  };
}
