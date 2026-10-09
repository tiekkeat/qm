import { sendJson } from "../http.ts";
import { isObj, authorizeAdmin, orgScope } from "./shared.ts";
import { samePerson, canonicalPerson } from "../../directory/person.ts";
import { McpAccessError, type McpConnectionInput, type McpAccountInput } from "../../mcp/mcp-connection-service.ts";
import type { McpAccess } from "../../mcp/mcp-connection-store.ts";
import type { ApiCtx, Route } from "./route.ts";

function actor(ctx: ApiCtx): string {
  const body = isObj(ctx.body) ? ctx.body : {};
  const requested =
    typeof body.principalId === "string" ? body.principalId : (ctx.url.searchParams.get("principalId") ?? "");
  if (ctx.capability) {
    if (ctx.method !== "GET" && ctx.capability.liveActor !== true && ctx.capability.liveAuthor !== true)
      throw new Error("MCP management requires a live user action");
    if (requested && !samePerson(requested, ctx.capability.actorId)) throw new McpAccessError();
    return canonicalPerson(ctx.capability.actorId);
  }
  if (ctx.actor) {
    const principal = ctx.actor.p;
    if (requested && !samePerson(requested, principal)) throw new McpAccessError();
    return canonicalPerson(principal);
  }
  if (!requested) throw new Error("principalId required");
  return canonicalPerson(requested);
}
function connectionInput(body: unknown, partial = false): Partial<McpConnectionInput> {
  if (!isObj(body)) throw new Error("JSON object required");
  const out: Partial<McpConnectionInput> = {};
  for (const field of ["name", "url"] as const) {
    if (body[field] !== undefined) {
      if (typeof body[field] !== "string" || !body[field].trim() || body[field].length > (field === "name" ? 80 : 2048))
        throw new Error(`Invalid ${field}`);
      out[field] = body[field].trim();
    } else if (!partial) throw new Error(`${field} required`);
  }
  if (body.auth !== undefined) {
    if (!["none", "bearer", "client-credentials", "oauth"].includes(String(body.auth)))
      throw new Error("Invalid authentication method");
    out.auth = body.auth as McpConnectionInput["auth"];
  } else if (!partial) out.auth = "none";
  for (const field of ["enabled", "unattended"] as const)
    if (body[field] !== undefined) {
      if (typeof body[field] !== "boolean") throw new Error(`${field} must be boolean`);
      out[field] = body[field];
    }
  if (typeof body.ownerScopeId === "string") out.ownerScopeId = body.ownerScopeId;
  if (body.homeAccountOwner === null || typeof body.homeAccountOwner === "string")
    out.homeAccountOwner = body.homeAccountOwner;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 64)
      throw new Error("tools must be an array of at most 64 tools");
    out.tools = body.tools.map((tool) => {
      if (
        !isObj(tool) ||
        typeof tool.name !== "string" ||
        typeof tool.approved !== "boolean" ||
        typeof tool.readOnly !== "boolean"
      )
        throw new Error("Invalid tool approval");
      return { name: tool.name, approved: tool.approved, readOnly: tool.readOnly };
    });
  }
  return out;
}
function shareInput(body: unknown): McpAccess {
  if (
    !isObj(body) ||
    typeof body.scopeId !== "string" ||
    !Array.isArray(body.tools) ||
    body.tools.length > 64 ||
    !body.tools.every((tool) => typeof tool === "string") ||
    typeof body.write !== "boolean" ||
    typeof body.unattended !== "boolean" ||
    !["own", "saved"].includes(String(body.account))
  )
    throw new Error("Share requires scopeId, tools, write, unattended, and account (own or saved)");
  return {
    scopeId: body.scopeId,
    tools: [...new Set(body.tools as string[])],
    write: body.write,
    unattended: body.unattended,
    account: body.account as "own" | "saved",
  };
}
async function handle(ctx: ApiCtx): Promise<void> {
  const service = ctx.deps.mcpConnections;
  if (!service) return sendJson(ctx.res, 404, { error: "not_found" });
  try {
    const admin = ctx.pathname.startsWith("/v1/admin/");
    const principal = admin ? (await authorizeAdmin(ctx, orgScope()))?.id : actor(ctx);
    if (!principal) return;
    const id = ctx.params.id;
    const suffix = ctx.pathname.split("/").at(-1);
    if (admin) {
      if (suffix === "mcp-policy") {
        const policy = ctx.method === "PUT" ? await service.policy.write(ctx.body) : await service.policy.read();
        if (ctx.method === "PUT")
          ctx.deps.auditLog?.record({
            at: Date.now(),
            principalId: principal,
            action: "mcp.policy.update",
            resource: "mcp-policy",
            scopeLabel: orgScope(),
            status: "ok",
          });
        return sendJson(ctx.res, 200, { policy });
      }
      if (ctx.method === "POST" && id) {
        if (suffix === "unblock") await service.unblock(id, principal);
        else await service.disable(id, principal);
        return sendJson(ctx.res, 200, { ok: true });
      }
      return sendJson(ctx.res, 200, { connections: await service.inventory() });
    }
    if (!id) {
      if (ctx.method === "POST")
        return sendJson(ctx.res, 201, {
          connection: await service.create(principal, connectionInput(ctx.body) as McpConnectionInput),
        });
      return sendJson(ctx.res, 200, {
        connections: await service.list(principal),
        projects: await service.projectScopes(principal),
        legacy: ((await ctx.deps.mcpServers?.list()) ?? []).map(({ id, name, url, enabled }) => ({
          id,
          name,
          url,
          enabled,
          legacy: true,
        })),
      });
    }
    if (suffix === "test") return sendJson(ctx.res, 200, { tools: await service.test(id, principal) });
    if (suffix === "tools") return sendJson(ctx.res, 200, { tools: (await service.get(id, principal)).tools });
    if (suffix === "account") {
      if (ctx.method === "DELETE") {
        await service.disconnect(id, principal);
        return sendJson(ctx.res, 200, { ok: true });
      }
      const body = isObj(ctx.body) ? ctx.body : {};
      const input: McpAccountInput = {};
      for (const field of ["bearerToken", "clientId", "clientSecret", "issuer", "tokenUrl"] as const)
        if (body[field] !== undefined) {
          if (typeof body[field] !== "string" || body[field].length > 16_000 || /[\r\n]/.test(body[field]))
            throw new Error(`Invalid ${field}`);
          input[field] = body[field];
        }
      return sendJson(ctx.res, 200, await service.connect(id, principal, input));
    }
    if (suffix === "shares") {
      if (ctx.method === "DELETE") {
        const target = ctx.url.searchParams.get("scopeId");
        if (!target) throw new Error("scopeId required");
        await service.revoke(id, principal, target);
        return sendJson(ctx.res, 200, { ok: true });
      }
      return sendJson(ctx.res, 200, { connection: await service.share(id, principal, shareInput(ctx.body)) });
    }
    if (ctx.method === "GET") return sendJson(ctx.res, 200, { connection: await service.get(id, principal) });
    if (ctx.method === "PATCH")
      return sendJson(ctx.res, 200, {
        connection: await service.update(id, principal, connectionInput(ctx.body, true)),
      });
    await service.delete(id, principal);
    return sendJson(ctx.res, 200, { ok: true });
  } catch (error) {
    if (error instanceof McpAccessError) return sendJson(ctx.res, 404, { error: "not_found", message: error.message });
    const message = error instanceof Error ? error.message : "MCP request failed";
    return sendJson(ctx.res, 400, { error: "mcp_request_failed", message });
  }
}
export const mcpConnectionRoutes: ReadonlyArray<Route<ApiCtx>> = [
  {
    method: "GET",
    path: "/v1/mcp-oauth/client-metadata",
    auth: "public",
    handle: (ctx) => {
      if (!ctx.deps.mcpConnections) return sendJson(ctx.res, 404, { error: "not_found" });
      return sendJson(ctx.res, 200, ctx.deps.mcpConnections.clientMetadata());
    },
  },

  ...["GET", "POST"].map((method) => ({ method, path: "/v1/mcp-connections", auth: "either" as const, handle })),
  ...["GET", "PATCH", "DELETE"].map((method) => ({
    method,
    path: "/v1/mcp-connections/:id",
    auth: "either" as const,
    handle,
  })),
  { method: "POST", path: "/v1/mcp-connections/:id/test", auth: "either", handle },
  { method: "GET", path: "/v1/mcp-connections/:id/tools", auth: "either", handle },
  ...["POST", "DELETE"].map((method) => ({
    method,
    path: "/v1/mcp-connections/:id/account",
    auth: "either" as const,
    handle,
  })),
  ...["POST", "DELETE"].map((method) => ({
    method,
    path: "/v1/mcp-connections/:id/shares",
    auth: "either" as const,
    handle,
  })),
  { method: "GET", path: "/v1/admin/mcp-connections", auth: "either", handle },
  { method: "POST", path: "/v1/admin/mcp-connections/:id/disable", auth: "either", handle },
  { method: "POST", path: "/v1/admin/mcp-connections/:id/unblock", auth: "either", handle },
  ...["GET", "PUT"].map((method) => ({ method, path: "/v1/admin/mcp-policy", auth: "either" as const, handle })),
  {
    method: "GET",
    path: "/v1/mcp-oauth/callback",
    auth: "public",
    handle: async (ctx) => {
      try {
        if (!ctx.deps.mcpConnections) return sendJson(ctx.res, 404, { error: "not_found" });
        const id = await ctx.deps.mcpConnections.callback(
          ctx.url.searchParams.get("state") ?? "",
          ctx.url.searchParams.get("code") ?? "",
        );
        return sendJson(ctx.res, 200, { connected: true, connectionId: id });
      } catch {
        return sendJson(ctx.res, 400, {
          error: "oauth_failed",
          message: "Authorization failed or expired; return to MCP and reconnect",
        });
      }
    },
  },
];
