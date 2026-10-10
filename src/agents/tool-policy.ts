const isolatedTools = new Set(["subagents", "sessions", "runtime", "cron", "webhook"]);
export function allowsAgentTool(allowed: readonly string[] | null | undefined, name: string, action?: string): boolean {
  if (allowed == null) return true;
  if (isolatedTools.has(name)) return false;
  if (name === "agent_package") return true;
  return allowed.includes(name) || (!!action && allowed.includes(`${name}.${action}`));
}
export function exposesAgentTool(allowed: readonly string[] | null | undefined, name: string): boolean {
  return (
    allowsAgentTool(allowed, name) ||
    (!isolatedTools.has(name) && !!allowed?.some((entry) => entry.startsWith(`${name}.`)))
  );
}
export function agentApiOperation(
  method: string,
  path: string,
  body: unknown,
): { name: string; action: string } | null {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const family = path.match(
    /^\/v1\/(agents|files|blobs|skills|memory|soul|history|guidance|sandbox-resources|context)(?:\/|$)/,
  )?.[1];
  if (!family || path.endsWith("/binding")) return null;
  const names: Record<string, string> = { blobs: "files", soul: "memory", "sandbox-resources": "sandbox" };
  const name = names[family] ?? family;
  if (method === "GET") return { name, action: family === "memory" ? "recall" : "read" };
  if (name === "agents" && method === "POST" && /^\/v1\/agents\/[^/]+$/.test(path) && typeof value.action === "string")
    return { name, action: value.action };
  if (name === "agents" && method === "POST" && path === "/v1/agents") return { name, action: "create" };
  return { name, action: method === "DELETE" ? "delete" : "write" };
}
