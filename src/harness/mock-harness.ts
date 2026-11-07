import { createMockAgent } from "../agent/mock-agent.ts";
import { agentHarness } from "./agent-adapter.ts";
export function createMockHarness() {
  return agentHarness(createMockAgent(), "mock");
}
