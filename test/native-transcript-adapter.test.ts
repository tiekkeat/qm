import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeEntryItem, nativeHistoryItem, itemNativeEntry } from "../src/harness/transcript.ts";
import { storedItem, type NewItem } from "../src/sessions/items.ts";
import { harnessAgent, agentHarness } from "../src/harness/agent-adapter.ts";
import type { Agent, AgentTurnInput } from "../src/agent/agent.ts";

const scope = "personal:alice" as const;
const sessionId = "test-session";
const save = (item: NewItem, seq = 1) => storedItem(item, { sessionId, seq, createdAt: 1720000000000 });

test("native history preserves current transcript columns and bodies across every item kind", () => {
  const records: NewItem[] = [
    { kind: "UserMessage", text: "question", author: "alice", externalId: "message-1" },
    { kind: "SteeringMessage", text: "clarification", author: "bob" },
    { kind: "AgentMessage", text: "answer", body: { wire: { content: [{ type: "text", text: "answer" }] } } },
    { kind: "Reasoning", text: "reasoning", hidden: true },
    { kind: "ToolCall", callId: "call-1", tool: "execute", body: { command: "pwd" } },
    { kind: "ToolResult", callId: "call-1", tool: "execute", isError: true, text: "denied" },
    { kind: "Elicitation", elicitId: "approval-1", body: { command: "publish" } },
    { kind: "ElicitationResponse", elicitId: "approval-1", approved: false, author: "alice" },
    { kind: "ContextCompaction", throughSeq: 7, text: "checkpoint" },
    { kind: "Stop", text: "cancelled", author: "alice" },
    { kind: "Error", errorCode: "provider_error", text: "unavailable" },
    { kind: "Wake", wakeCause: "system", body: { reason: "retry" } },
  ];
  for (const [index, record] of records.entries()) {
    const item = save(record, index + 1);
    assert.deepEqual(nativeHistoryItem(itemNativeEntry(item, scope)), item);
  }
});

test("native output retains reasoning, tool identifiers, errors and compaction boundaries", () => {
  const tool = nativeEntryItem({
    type: "tool_result",
    scopeLabel: scope,
    payload: { callId: "call-1", tool: "execute", text: "denied", ok: false },
  });
  assert.equal(tool.kind, "ToolResult");
  assert.equal(tool.callId, "call-1");
  assert.equal(tool.isError, true);
  assert.equal(tool.text, "denied");
  assert.equal(
    nativeEntryItem({ type: "thinking", scopeLabel: scope, payload: { thinking: "reason" } }).text,
    "reason",
  );
  const checkpoint = nativeEntryItem({
    type: "system",
    scopeLabel: scope,
    payload: { kind: "context_compaction", throughSeq: 15, text: "summary" },
  });
  assert.equal(checkpoint.kind, "ContextCompaction");
  assert.equal(checkpoint.throughSeq, 15);
  assert.throws(
    () => nativeEntryItem({ type: "tool_call", scopeLabel: scope, payload: { tool: "execute" } }),
    /call ID/,
  );
});

test("Pi adapter round trip delivers the original current turn and persists original items", async () => {
  const emitted: NewItem[] = [];
  const history = [save({ kind: "UserMessage", text: "question", author: "alice" })];
  const output: NewItem = { kind: "AgentMessage", text: "answer", body: { wire: { model: "test" } } };
  const tools = {};
  const agent: Agent = {
    async runTurn(input) {
      assert.deepEqual(input.history, history);
      assert.equal(input.tools, tools);
      assert.equal(input.input, "question");
      const stored = await input.emit(output);
      assert.equal(stored.seq, 2);
      assert.equal(stored.text, "answer");
      return { reply: "answer" };
    },
  };
  const input = {
    session: { id: sessionId, scopeId: scope },
    scopeLabel: scope,
    input: "question",
    history,
    tools,
    emit: async (item: NewItem) => {
      emitted.push(item);
      return save(item, 2);
    },
  } as AgentTurnInput;
  const result = await harnessAgent(agentHarness(agent)).runTurn(input);
  assert.equal(result.reply, "answer");
  assert.deepEqual(emitted, [output]);
});
