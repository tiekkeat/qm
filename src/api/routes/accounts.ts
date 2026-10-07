import { withinRateLimit } from "../../../plugins/chassis/src/claims.ts";
import {
  hashPassword,
  parsePasswordHash,
  passwordProblem,
  verifyPassword,
} from "../../../plugins/chassis/src/password.ts";
import { validEmail } from "../../../plugins/chassis/src/email.ts";
import type { LoginPolicy } from "../../../plugins/chassis/src/accounts.ts";
import { externalMemberActive } from "../../identity/external-members.ts";
import { sendJson } from "../http.ts";
import { activePrincipal, audit, authorizeAdmin, isObj, orgScope } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

export async function passwordAccountActive(ctx: ApiCtx, email: string): Promise<boolean> {
  const { deps } = ctx;
  if (!deps.identity) return false;
  await deps.identity.refresh(true);
  if (deps.identity.deactivationSource(email) === "manual") return false;
  const member = deps.identity.externalMember(email);
  return member
    ? externalMemberActive(member)
    : !!(
        deps.emailAuthPrincipals?.includes(email) ||
        (deps.emailAuthDomain && email.endsWith(`@${deps.emailAuthDomain}`)) ||
        (await activePrincipal(deps, email))
      );
}
async function passwordAttempt(ctx: ApiCtx, email: string): Promise<boolean> {
  if (!ctx.deps.replayDedupe?.durable || !ctx.secret) {
    sendJson(ctx.res, 503, { error: "not_configured" });
    return false;
  }
  const store = {
    async claimFirst(ids: readonly string[], expiresAtMs: number) {
      for (const id of ids) if (await ctx.deps.replayDedupe!.claim(`password-management:${id}`, expiresAtMs)) return id;
      return null;
    },
  };
  if (
    await withinRateLimit(store, {
      secret: ctx.secret,
      kind: "password-management",
      value: email,
      limit: 20,
      windowS: 900,
      nowMs: Date.now(),
    })
  )
    return true;
  sendJson(ctx.res, 429, { error: "rate_limited", message: "Too many password attempts. Try again later." });
  return false;
}
async function accounts(ctx: ApiCtx): Promise<void> {
  const { deps, res, url, body } = ctx;
  const store = deps.accounts;
  if (!store) return sendJson(res, 503, { error: "not_configured", message: "Password accounts require Postgres." });
  const b = isObj(body) ? body : {};
  const suffix = ctx.pathname.slice("/v1/auth/accounts".length);
  const policy = await store.policy();
  if (suffix === "/policy") return sendJson(res, 200, { policy });
  const email = String(b.email ?? url.searchParams.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (suffix === "/session") {
    const account = await store.get(email);
    const version = Number(url.searchParams.get("version") ?? "0");
    return sendJson(res, 200, {
      valid:
        !account ||
        ((policy === "email" || url.searchParams.get("recovery") === "1" || !account.mustChangePassword) &&
          account.version === version),
      version: account?.version ?? 0,
    });
  }
  if (suffix === "/self") {
    const principal = ctx.actor?.p;
    if (!principal || !validEmail(principal) || !(await passwordAccountActive(ctx, principal)))
      return sendJson(res, 403, {
        error: "forbidden",
        message: "Sign in with your email account to manage its password.",
      });
    const account = await store.get(principal);
    if (ctx.req.method === "GET") return sendJson(res, 200, { email: principal, hasPassword: !!account, policy });
    if (policy === "email")
      return sendJson(res, 403, { error: "method_disabled", message: "Password sign-in is disabled." });
    if (!(await passwordAttempt(ctx, principal))) return;
    if (account && !(await verifyPassword(String(b.currentPassword ?? ""), account.passwordHash)))
      return sendJson(res, 400, { error: "incorrect_password", message: "Your current password is incorrect." });
    const password = String(b.password ?? "");
    const problem = passwordProblem(password);
    if (problem) return sendJson(res, 400, { error: "invalid_password", message: problem });
    const token = await store.issue({ email: principal, kind: "change", version: account?.version ?? 0 });
    const saved = await store.complete(token, await hashPassword(password));
    if (!saved) return sendJson(res, 409, { error: "conflict", message: "The password changed. Try again." });
    await deps.brokerSessions?.revoke(principal);
    audit(deps, {
      principalId: principal,
      action: "auth.password.change",
      resource: principal,
      scopeLabel: orgScope(),
    });
    return sendJson(res, 200, { email: principal, version: saved.version });
  }
  if (suffix === "/complete") {
    const token = String(b.token ?? "");
    const value = /^[A-Za-z0-9_-]{43}$/.test(token) ? await store.ticket(token) : null;
    if (!value || !(await passwordAccountActive(ctx, value.email)))
      return sendJson(res, 400, {
        error: "invalid_ticket",
        message: "This password link is expired, revoked, or already used.",
      });
    if (value.inviteId && deps.identity?.externalMember(value.email)?.inviteId !== value.inviteId)
      return sendJson(res, 400, { error: "invalid_ticket", message: "This invitation was replaced." });
    if (!(await passwordAttempt(ctx, value.email))) return;
    const skip = b.skip === true;
    if (skip && (value.kind !== "setup" || policy !== "both"))
      return sendJson(res, 400, {
        error: "password_required",
        message: "A password is required to finish onboarding.",
      });
    if (!skip && policy === "email")
      return sendJson(res, 403, { error: "method_disabled", message: "Password sign-in is disabled." });
    const password = String(b.password ?? "");
    const problem = skip ? null : passwordProblem(password);
    if (problem) return sendJson(res, 400, { error: "invalid_password", message: problem });
    const saved = await store.complete(token, skip ? null : await hashPassword(password));
    if (!saved)
      return sendJson(res, 400, {
        error: "invalid_ticket",
        message: "This password link is expired, revoked, or already used.",
      });
    if (!skip) await deps.brokerSessions?.revoke(value.email);
    audit(deps, {
      principalId: value.email,
      action: skip ? "auth.password.skip" : "auth.password.change",
      resource: value.email,
      scopeLabel: orgScope(),
    });
    return sendJson(res, 200, { email: value.email, version: saved.version });
  }
  if (!validEmail(email)) return sendJson(res, 400, { error: "invalid_email" });
  const account = await store.get(email);
  if (suffix === "/import") {
    const hash = String(b.hash ?? "");
    if (!parsePasswordHash(hash) || !(await passwordAccountActive(ctx, email)))
      return sendJson(res, 400, { error: "invalid_account" });
    await store.create(email, hash, false, 0);
    return sendJson(res, 200, { ok: true });
  }
  if (suffix === "/begin") {
    if (!(await passwordAccountActive(ctx, email))) return sendJson(res, 403, { error: "inactive_account" });
    const token =
      account?.mustChangePassword && policy !== "email"
        ? await store.issue({ email, kind: "change", version: account.version })
        : undefined;
    return sendJson(res, 200, { ...(token ? { token } : {}), version: account?.version ?? 0 });
  }
  if (suffix === "/verify") {
    const matched = await verifyPassword(String(b.password ?? ""), account?.passwordHash);
    if (policy === "email" || !matched || !(await passwordAccountActive(ctx, email)))
      return sendJson(res, 200, { matched: false, managed: !!account });
    const token = account!.mustChangePassword
      ? await store.issue({ email, kind: "change", version: account!.version })
      : undefined;
    return sendJson(res, 200, {
      matched: true,
      managed: true,
      mustChangePassword: account!.mustChangePassword,
      ...(token ? { token } : {}),
    });
  }
  if (suffix === "/reset") {
    if (policy === "email" || !account || !(await passwordAccountActive(ctx, email)))
      return sendJson(res, 200, { ok: true });
    if (deps.inviteMailer && deps.portalUrl) {
      const token = await store.issue({ email, kind: "reset", version: account.version });
      const link = `${deps.portalUrl.replace(/\/+$/, "")}/auth/password/setup#token=${encodeURIComponent(token)}`;
      try {
        await deps.inviteMailer.send({
          to: email,
          subject: "Reset your QM password",
          text: `Open this single-use link to reset your password: ${link}\nIt expires in 15 minutes. If you did not request a reset, ignore this email.`,
          html: `<h1>Reset your password</h1><p><a href="${link}">Choose a new password</a></p><p>This link works once and expires in 15 minutes. If you did not request a reset, ignore this email.</p>`,
        });
      } catch {
        return sendJson(res, 200, { ok: true });
      }
    }
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: "not_found" });
}
export async function setLoginPolicy(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope());
  if (!actor) return;
  if (ctx.capability) return sendJson(ctx.res, 403, { error: "forbidden" });
  if (!ctx.deps.accounts) return sendJson(ctx.res, 503, { error: "not_configured" });
  const policy = isObj(ctx.body) ? ctx.body.policy : null;
  if (!["both", "password", "email"].includes(String(policy)))
    return sendJson(ctx.res, 400, { error: "invalid_policy" });
  if (policy === "password") {
    const account = await ctx.deps.accounts.get(ctx.actor?.p ?? actor.id);
    if (!account || account.mustChangePassword)
      return sendJson(ctx.res, 409, {
        error: "lockout_prevented",
        message: "Set your own permanent password before selecting Password only.",
      });
  }
  await ctx.deps.accounts.setPolicy(policy as LoginPolicy);
  audit(ctx.deps, {
    principalId: actor.id,
    action: "auth.policy.update",
    resource: String(policy),
    scopeLabel: orgScope(),
  });
  return sendJson(ctx.res, 200, { policy });
}
export async function adminPasswordReset(ctx: ApiCtx): Promise<void> {
  const actor = await authorizeAdmin(ctx, orgScope());
  if (!actor) return;
  if (ctx.capability) return sendJson(ctx.res, 403, { error: "forbidden" });
  const store = ctx.deps.accounts;
  if (!store) return sendJson(ctx.res, 503, { error: "not_configured" });
  const b = isObj(ctx.body) ? ctx.body : {};
  const email = String(b.email ?? "")
    .trim()
    .toLowerCase();
  const password = String(b.password ?? "");
  const problem = passwordProblem(password);
  if (!validEmail(email) || problem)
    return sendJson(ctx.res, 400, { error: "invalid_password", message: problem ?? "Valid email required." });
  if ((await store.policy()) === "email")
    return sendJson(ctx.res, 409, {
      error: "method_disabled",
      message: "Enable password sign-in before issuing a temporary password.",
    });
  if (!(await passwordAccountActive(ctx, email))) return sendJson(ctx.res, 403, { error: "inactive_account" });
  const hash = await hashPassword(password);
  if (!(await store.replace(email, hash, true))) await store.create(email, hash, true);
  await ctx.deps.brokerSessions?.revoke(email);
  audit(ctx.deps, { principalId: actor.id, action: "auth.password.reset", resource: email, scopeLabel: orgScope() });
  return sendJson(ctx.res, 200, { ok: true });
}
export const accountRoutes: ReadonlyArray<Route<ApiCtx>> = [
  ...["policy", "session", "self"].map(
    (path) => ({ method: "GET", path: `/v1/auth/accounts/${path}`, auth: "source", handle: accounts }) as Route<ApiCtx>,
  ),
  ...["verify", "complete", "import", "reset", "self", "begin"].map(
    (path) =>
      ({ method: "POST", path: `/v1/auth/accounts/${path}`, auth: "source", handle: accounts }) as Route<ApiCtx>,
  ),
  { method: "POST", path: "/v1/admin/users/login-policy", auth: "either", handle: setLoginPolicy },
  { method: "POST", path: "/v1/admin/users/password", auth: "either", handle: adminPasswordReset },
];
