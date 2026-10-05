import { createCodexDeviceLogin } from "../../../model/codex-device-login.ts";
import { errMessage } from "../../../util/errors.ts";
import type { UserModelCredentialStore } from "../../../model/user-model-credential-store.ts";
import type { ServerDeps } from "../../deps.ts";
import { sendJson } from "../../http.ts";
import type { ApiCtx } from "../route.ts";
import { audit, authorizeAdmin, orgScope } from "../shared.ts";

const login = createCodexDeviceLogin();

async function completeLogin(
  store: UserModelCredentialStore,
  deps: ServerDeps,
  id: string,
  actorId: string,
  expiresAt: number,
): Promise<void> {
  try {
    while (Date.now() < expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const result = await login.poll(id);
      if (result === "pending") continue;
      if (!(await store.completeSharedLogin(id, result))) return;
      audit(deps, { principalId: actorId, action: "shared-codex.connected", resource: "openai", scopeLabel: orgScope(deps) });
      return;
    }
  } catch {
    await store.finishSharedLogin(id, "failed");
    return;
  }
  await store.finishSharedLogin(id, "failed");
}

async function admin(ctx: ApiCtx) {
  return authorizeAdmin(ctx, orgScope(ctx.deps));
}

export async function sharedCodexStatus(ctx: ApiCtx): Promise<void> {
  const actor = await admin(ctx);
  if (!actor) return;
  if (!ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  return sendJson(ctx.res, 200, await ctx.deps.userModelCredentials.sharedStatus());
}

export async function sharedCodexStart(ctx: ApiCtx): Promise<void> {
  const actor = await admin(ctx);
  if (!actor) return;
  if (!ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  try {
    const prompt = await login.start();
    await ctx.deps.userModelCredentials.putSharedLogin(prompt.deviceAuthId, actor.id, prompt.expiresAt);
    void completeLogin(ctx.deps.userModelCredentials, ctx.deps, prompt.deviceAuthId, actor.id, prompt.expiresAt);
    audit(ctx.deps, { principalId: actor.id, action: "shared-codex.login-start", resource: "openai", scopeLabel: orgScope(ctx.deps) });
    return sendJson(ctx.res, 200, prompt);
  } catch (error) {
    return sendJson(ctx.res, 502, { error: "oauth_start_failed", message: errMessage(error) });
  }
}

export async function sharedCodexPoll(ctx: ApiCtx): Promise<void> {
  const actor = await admin(ctx);
  if (!actor) return;
  if (!ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  const id = (ctx.body as { deviceAuthId?: unknown } | null)?.deviceAuthId;
  if (typeof id !== "string") return sendJson(ctx.res, 404, { error: "login_not_found" });
  const pending = await ctx.deps.userModelCredentials.getSharedLogin(id);
  if (!pending || pending.actorId !== actor.id)
    return sendJson(ctx.res, 404, { error: "login_not_found" });
  if (pending.status === "pending") return sendJson(ctx.res, 200, { status: "pending" });
  await ctx.deps.userModelCredentials.deleteSharedLogin(id);
  return sendJson(ctx.res, 200, { status: pending.status });
}

export async function sharedCodexDisconnect(ctx: ApiCtx): Promise<void> {
  const actor = await admin(ctx);
  if (!actor) return;
  if (!ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  await ctx.deps.userModelCredentials.deleteSharedOAuth();
  audit(ctx.deps, { principalId: actor.id, action: "shared-codex.disconnect", resource: "openai", scopeLabel: orgScope(ctx.deps) });
  return sendJson(ctx.res, 200, { ok: true });
}

export async function sharedCodexGrant(ctx: ApiCtx): Promise<void> {
  const actor = await admin(ctx);
  if (!actor) return;
  if (!ctx.deps.userModelCredentials) return sendJson(ctx.res, 404, { error: "not_found" });
  const userId = ctx.params.principalId?.trim();
  if (!userId || userId.length > 320) return sendJson(ctx.res, 400, { error: "invalid_principal" });
  const enabled = ctx.method === "PUT";
  await ctx.deps.userModelCredentials.setSharedGrant(userId, enabled);
  audit(ctx.deps, {
    principalId: actor.id,
    action: enabled ? "shared-codex.grant" : "shared-codex.revoke",
    resource: userId,
    scopeLabel: orgScope(ctx.deps),
  });
  return sendJson(ctx.res, 200, { ok: true });
}
