import assert from "node:assert/strict";
import test from "node:test";
import type { ResponseStreamEvent } from "openai/resources/responses/responses";
import type { Model, AssistantMessage } from "@earendil-works/pi-ai";
import { getServiceTierCostMultiplier } from "@earendil-works/pi-ai/api/openai-responses";
import { processResponsesStream } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

test("Pi 1.0.4 exposes the served-tier prices needed by QM billing", () => {
  assert.equal(getServiceTierCostMultiplier({ id: "gpt-5.5" }, "priority"), 2.5);
  assert.equal(getServiceTierCostMultiplier({ id: "gpt-5.5" }, "fast"), 2.5);
  assert.equal(getServiceTierCostMultiplier({ id: "gpt-5.5" }, "flex"), 0.5);
  assert.equal(getServiceTierCostMultiplier({ id: "gpt-5.5" }, "default"), 1);
});

test("Pi keeps the reported service tier when a response is served below the requested tier", async () => {
  const model: Model<"openai-responses"> = {
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16000,
  };
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  let pricedTier: string | undefined;
  async function* response() {
    yield {
      type: "response.completed" as const,
      response: {
        id: "resp_served_default",
        status: "completed",
        output: [],
        service_tier: "default",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    } as unknown as ResponseStreamEvent;
  }
  await processResponsesStream(response(), output, new AssistantMessageEventStream(), model, {
    serviceTier: "priority",
    applyServiceTierPricing(_usage, tier) {
      pricedTier = tier ?? undefined;
    },
  });
  assert.equal(output.serviceTier, "default");
  assert.equal(pricedTier, "default");
  assert.equal(output.usage.totalTokens, 15);
  assert.equal(output.stopReason, "stop");
});
