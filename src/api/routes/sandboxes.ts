import { redactSecrets } from "../../harness/redact-secrets.ts";
import { errMessage } from "../../util/errors.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";
import type { SandboxAction } from "../app-sandboxes.ts";

function principal(ctx: ApiCtx): string | null {
  const input = isObj(ctx.body) ? ctx.body : {};
  const requested = ctx.method === "GET" ? ctx.url.searchParams.get("principalId") : input.principalId;
  const actor = ctx.capability?.actorId ?? ctx.actor?.p ?? requested;
  if (typeof actor !== "string" || !actor || (requested && requested !== actor)) {
    sendJson(ctx.res, 403, { error: "forbidden" });
    return null;
  }
  return actor;
}
async function handle(ctx: ApiCtx): Promise<void> {
  const actor = principal(ctx);
  if (!actor) return;
  if (ctx.capability && ctx.method !== "GET" && ctx.capability.liveActor !== true && ctx.capability.liveAuthor !== true)
    return sendJson(ctx.res, 403, { error: "live_user_required" });
  try {
    if (ctx.params.scopeId) {
      if (ctx.method === "GET") return sendJson(ctx.res, 200, await ctx.app.listSandboxes(actor, ctx.params.scopeId));
      const input = isObj(ctx.body) ? ctx.body : {};
      if (!["create", "default", "status", "restart", "retire"].includes(String(input.action)))
        return sendJson(ctx.res, 400, { error: "invalid_action" });
      if (input.sandboxId !== undefined && input.sandboxId !== null && typeof input.sandboxId !== "string")
        return sendJson(ctx.res, 400, { error: "invalid_sandbox" });
      const action: SandboxAction = {
        action: input.action as SandboxAction["action"],
        sandboxId: input.sandboxId as string | null | undefined,
        backend: typeof input.backend === "string" ? input.backend : undefined,
        name: typeof input.name === "string" ? input.name : undefined,
        confirm: input.confirm === true,
      };
      return sendJson(ctx.res, 200, await ctx.app.manageSandbox(actor, ctx.params.scopeId, action));
    }
    const id = ctx.params.id!;
    if (ctx.pathname.endsWith("/archive")) return sendJson(ctx.res, 200, await ctx.app.projectArchive(actor, id));
    if (ctx.method === "GET") return sendJson(ctx.res, 200, await ctx.app.projectDeletionPreview(actor, id));
    if (!isObj(ctx.body) || ctx.body.confirm !== true)
      return sendJson(ctx.res, 400, { error: "confirmation_required" });
    const project = await ctx.app.deleteProject(actor, id);
    return sendJson(ctx.res, project.lifecycle === "archived" ? 200 : 202, { project });
  } catch (error) {
    ctx.deps.auditLog?.record({
      at: Date.now(),
      principalId: actor,
      action: "sandbox.request.failed",
      resource: ctx.params.scopeId ?? ctx.params.id!,
      scopeLabel: ctx.params.scopeId ?? `group:web-project-${ctx.params.id}`,
      status: "failed",
    });
    ctx.deps.errors?.record({
      category: "sandbox",
      code: "management_failed",
      message: redactSecrets(errMessage(error)),
      scopeLabel: ctx.params.scopeId ?? `group:web-project-${ctx.params.id}`,
    });
    console.error("[sandbox-management]", redactSecrets(errMessage(error)));
    return sendJson(ctx.res, 409, {
      error: "request_failed",
      message:
        "The request could not finish. Check ownership, supported actions, and running work, then refresh and retry.",
    });
  }
}
export const sandboxRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/scopes/:scopeId/sandboxes", auth: "either", handle },
  { method: "POST", path: "/v1/scopes/:scopeId/sandboxes", auth: "either", handle },
  { method: "GET", path: "/v1/projects/:id/deletion", auth: "either", handle },
  { method: "DELETE", path: "/v1/projects/:id", auth: "either", handle },
  { method: "GET", path: "/v1/projects/:id/archive", auth: "either", handle },
];
