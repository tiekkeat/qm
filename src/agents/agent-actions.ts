import { AgentError, type AgentService, type AgentSelection } from "./agent-service.ts";
import type { ScopeId } from "../types.ts";
export async function agentAction(
  service: AgentService,
  actor: string,
  scope: ScopeId,
  action: string,
  input: Record<string, unknown>,
) {
  const id = typeof input.id === "string" ? input.id : "";
  const integer = (name: string) => {
    const n = input[name];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1)
      throw new AgentError(`${name} must be a positive integer`);
    return n;
  };
  switch (action) {
    case "list":
      return { agents: await service.list(actor, scope) };
    case "read":
      return service.view(actor, id, typeof input.version === "number" ? integer("version") : undefined, scope);
    case "create":
      return service.create(actor, scope, input.package);
    case "save":
      return service.save(
        actor,
        id,
        input.package,
        integer("expectedVersion"),
        typeof input.summary === "string" ? input.summary : undefined,
      );
    case "import-skill":
      return service.importSkill(actor, id, String(input.skillId ?? ""), integer("expectedVersion"));
    case "publish":
      return service.publish(actor, id, integer("version"));
    case "restore":
      return service.restore(actor, id, integer("version"), integer("expectedVersion"));
    case "suggest":
      return service.propose(actor, id, String(input.text ?? ""));
    case "grants":
      return { grants: await service.grants(actor, id) };
    case "share": {
      if (input.role !== null && input.role !== "user" && input.role !== "contributor")
        throw new AgentError("Choose User or Contributor");
      if (typeof input.scopeId !== "string") throw new AgentError("Recipient scope required");
      return service.share(actor, id, input.scopeId, input.role);
    }
    case "delete":
      return service.delete(actor, id, input.confirm === true);
    default:
      throw new AgentError("Unknown agent action");
  }
}
export function agentSelection(raw: unknown): AgentSelection | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== "object") throw new AgentError("Invalid agent selection");
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== "string" || typeof s.version !== "number" || !Number.isSafeInteger(s.version) || s.version < 1)
    throw new AgentError("Agent ID and version required");
  return { id: s.id, version: s.version, ...(s.test === true ? { test: true as const } : {}) };
}
