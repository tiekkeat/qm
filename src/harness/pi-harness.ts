import { createAgent, agentConfigOptions, renderDetectPrompt as renderPrompt } from "../agent/agent-run.ts";
import { agentHarness } from "./agent-adapter.ts";
import { nativeHistoryItem } from "./transcript.ts";
import type { HarnessDetectInput } from "./harness.ts";
export { buildDetectionPrompt, parseDetectVerdict } from "../agent/agent-run.ts";
export { TITLE_GENERATION_PROMPT, titleUserPrompt, sanitizeTitle } from "../agent/session-title-prompt.ts";
export * from "../model/model-runtime.ts";
export const piHarnessConfigOptions = agentConfigOptions;
export function createPiHarness(opts?: Parameters<typeof createAgent>[0]) {
  return agentHarness(createAgent(opts));
}
export function renderDetectPrompt(input: HarnessDetectInput) {
  return renderPrompt({ ...input, history: input.history.map(nativeHistoryItem) });
}
