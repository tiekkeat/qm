import { AgentError } from "../../agents/agent-service.ts";
import { agentAction, agentSelection } from "../../agents/agent-actions.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";
async function handle(ctx: ApiCtx) {
  const s = ctx.app.customAgents;
  if (!s) return sendJson(ctx.res, 503, { error: "Agents unavailable" });
  const input = isObj(ctx.body) ? ctx.body : {};
  const requested = ctx.method === "GET" ? ctx.url.searchParams.get("principalId") : input.principalId;
  const actor = ctx.capability?.actorId ?? ctx.actor?.p ?? requested;
  if (typeof actor !== "string" || !actor || (requested && requested !== actor))
    return sendJson(ctx.res, 403, { error: "forbidden" });
  const scope =
    ctx.capability?.scopeId ??
    (ctx.method === "GET" ? ctx.url.searchParams.get("scopeId") : input.scopeId) ??
    `personal:${actor}`;
  if (typeof scope !== "string") return sendJson(ctx.res, 400, { error: "scopeId required" });
  try {
    if (ctx.pathname.endsWith("/binding")) {
      if (ctx.method !== "GET" && ctx.capability)
        throw new AgentError("Selection changes require the user interface", 403);
      const thread = ctx.method === "GET" ? ctx.url.searchParams.get("threadRef") : input.threadRef;
      const isDefault = ctx.method === "GET" ? ctx.url.searchParams.get("default") === "1" : input.default === true;
      if (!isDefault && (typeof thread !== "string" || !thread)) throw new AgentError("threadRef required");
      if (!isDefault) {
        const session = await ctx.deps.sessions?.getByThread(String(thread));
        if (session) {
          if (session.scopeId !== scope || !(await ctx.app.getSessionForViewer(session.id, actor)))
            throw new AgentError("Conversation not found", 404);
        } else if (!String(thread).startsWith(`web:${actor}:`)) throw new AgentError("Conversation not found", 404);
      }
      if (!(await ctx.app.managesScope(actor, scope))) throw new AgentError("Workspace unavailable", 403);
      const key = isDefault ? `default:${scope}` : `selection:${thread}`;
      if (ctx.method === "GET")
        return sendJson(ctx.res, 200, {
          selection: isDefault
            ? ((await s.binding(key, scope)) ?? null)
            : await s.effectiveSelection(actor, scope, String(thread)),
        });
      return sendJson(ctx.res, 200, await s.bind(actor, key, scope, agentSelection(input.selection)));
    }
    if (ctx.method === "GET") {
      if (ctx.params.id)
        return sendJson(
          ctx.res,
          200,
          await s.view(
            actor,
            ctx.params.id,
            ctx.url.searchParams.has("version") ? Number(ctx.url.searchParams.get("version")) : undefined,
            scope,
          ),
        );
      return sendJson(ctx.res, 200, {
        agents: await s.list(
          actor,
          ctx.url.searchParams.has("scopeId") || ctx.capability ? scope : undefined,
          ctx.url.searchParams.get("deleted") === "1",
        ),
      });
    }
    if (ctx.capability && ctx.capability.liveActor !== true && ctx.capability.liveAuthor !== true)
      throw new AgentError("Agent changes require a human-started conversation", 403);
    let action = ctx.params.id ? String(input.action) : "create";
    if (ctx.method === "DELETE") action = "delete";
    const parameters = { ...input, ...(ctx.params.id ? { id: ctx.params.id } : {}) };
    return sendJson(ctx.res, 200, await agentAction(s, actor, scope, action, parameters));
  } catch (error) {
    if (error instanceof AgentError)
      return sendJson(ctx.res, error.status, { error: "agent_request_failed", message: error.message });
    throw error;
  }
}
export const agentRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/agents/binding", auth: "either", handle },
  { method: "POST", path: "/v1/agents/binding", auth: "either", handle },
  { method: "GET", path: "/v1/agents", auth: "either", handle },
  { method: "POST", path: "/v1/agents", auth: "either", handle, maxBodyBytes: 6_000_000 },
  { method: "GET", path: "/v1/agents/:id", auth: "either", handle },
  { method: "POST", path: "/v1/agents/:id", auth: "either", handle, maxBodyBytes: 6_000_000 },
  { method: "DELETE", path: "/v1/agents/:id", auth: "either", handle },
];
