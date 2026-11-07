import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { errMessage } from "../../util/errors.ts";
import { text, type ToolKit } from "./kit.ts";
export function customAgentTools(kit: ToolKit) {
  const { ref, recordCall, recordResult } = kit;
  const agents = defineTool({
    name: "agents",
    label: "agents",
    description:
      "Create, inspect, save, publish, restore, suggest improvements, share or delete custom agents. Use the agent-management skill. Changes require the asking user's authority; package saves never publish automatically. input is JSON; saves require expectedVersion and package. Deletion requires confirm:true after user confirmation.",
    parameters: Type.Object({
      action: Type.String({
        enum: [
          "list",
          "read",
          "create",
          "save",
          "publish",
          "restore",
          "suggest",
          "grants",
          "share",
          "delete",
          "import-skill",
        ],
      }),
      input: Type.Optional(
        Type.String({
          description:
            "JSON object with id, package, expectedVersion, version, summary, scopeId, role or confirm as required.",
        }),
      ),
    }),
    async execute(callId, params) {
      await recordCall(callId, { tool: "agents", action: params.action });
      try {
        if (!ref.current?.manageAgents) throw new Error("Agent management unavailable");
        const result = await ref.current.manageAgents(params.action, JSON.parse(params.input ?? "{}"));
        return recordResult(
          callId,
          { tool: "agents", action: params.action },
          text(JSON.stringify(result ?? { error: "Agent management unavailable" })),
          false,
        );
      } catch (error) {
        return recordResult(
          callId,
          { tool: "agents", action: params.action },
          text(`[error] ${errMessage(error)}`),
          true,
        );
      }
    },
  });
  const agentPackage = defineTool({
    name: "agent_package",
    label: "agent package",
    description:
      "Read instructions or a supporting file from the selected immutable custom agent package. Use path '.' for its file index and examples.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(callId, params) {
      await recordCall(callId, { tool: "agent_package", path: params.path });
      try {
        return recordResult(
          callId,
          { tool: "agent_package", path: params.path },
          text((await ref.current?.readAgentPackage?.(params.path)) ?? "No custom agent selected"),
          false,
        );
      } catch (error) {
        return recordResult(callId, { tool: "agent_package" }, text(errMessage(error)), true);
      }
    },
  });
  return [
    ...(ref.current === null || ref.current?.manageAgents ? [agents] : []),
    ...(ref.current === null || ref.current?.readAgentPackage ? [agentPackage] : []),
  ];
}
