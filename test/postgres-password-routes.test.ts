import "./support/auto-fake-sprites.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { buildApp, serverDeps } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { testConfig } from "./support/test-config.ts";
import { signedHeaders, withSourceAuthNonce } from "../plugins/chassis/src/core-client.ts";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../plugins/chassis/src/portal-identity.ts";
import { hashPassword } from "../plugins/chassis/src/password.ts";
const databaseUrl = process.env.DATABASE_URL;
const secret = "password-route-source-secret".repeat(3);
const portalSecret = "password-route-portal-secret".repeat(3);
const admin = "alice@example.test";
test(
  "admin accounts, invitation setup, recovery, policy enforcement and session invalidation",
  { skip: !databaseUrl },
  async (t) => {
    const config = testConfig({
      databaseUrl,
      adminGrants: `${admin}:org_admin`,
      signingSecret: secret,
      portalIdentitySecret: portalSecret,
      requireSignedPortalIdentity: true,
      publicWebUrl: "https://qm.example.test",
      emailAuthPrincipals: [admin],
    });
    const built = buildApp(config);
    const sent: { to: string; subject: string; text: string; html: string }[] = [];
    const deps = {
      ...serverDeps(config, built),
      inviteMailer: {
        async send(message: (typeof sent)[number]) {
          sent.push(message);
          return "captured";
        },
      },
    };
    const server = createServer(built.app, deps);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await built.runtime.stop();
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    async function call(pathname: string, body?: unknown, actor?: string) {
      const path = withSourceAuthNonce(pathname, secret),
        raw = body === undefined ? "" : JSON.stringify(body),
        method = body === undefined ? "GET" : "POST";
      const headers = signedHeaders(secret, method, path, raw);
      if (actor)
        headers[PORTAL_IDENTITY_HEADER] = mintPortalIdentity({ p: actor, exp: Date.now() + 60_000 }, portalSecret);
      const response = await fetch(base + path, { method, headers, ...(body === undefined ? {} : { body: raw }) });
      return { status: response.status, data: (await response.json()) as any };
    }
    assert.equal(
      (await call("/v1/admin/users/create", { email: "manual@example.test", password: "short" }, admin)).status,
      400,
    );
    assert.equal(
      (
        await call(
          "/v1/admin/users/create",
          { email: "manual@example.test", password: "temporary secure password" },
          admin,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          "/v1/admin/users/create",
          { email: "manual@example.test", password: "another secure password" },
          admin,
        )
      ).status,
      409,
    );
    assert.equal((await call("/v1/auth/accounts/self")).status, 401);
    assert.equal((await call("/v1/auth/accounts/self", { password: "unverified password" })).status, 401);
    assert.equal((await call("/v1/auth/accounts/self", undefined, admin)).status, 200);
    assert.equal(sent.length, 0);
    const checked = await call("/v1/auth/accounts/verify", {
      email: "manual@example.test",
      password: "temporary secure password",
    });
    assert.equal(checked.data.matched, true);
    assert.equal(checked.data.mustChangePassword, true);
    const change = await call("/v1/auth/accounts/complete", {
      token: checked.data.token,
      password: "permanent secure password",
    });
    assert.equal(change.status, 200);
    assert.equal(
      (await call("/v1/auth/accounts/verify", { email: "manual@example.test", password: "permanent secure password" }))
        .data.matched,
      true,
    );
    assert.equal(
      (await call("/v1/auth/accounts/begin", { email: "manual@example.test" })).data.version,
      change.data.version,
    );

    assert.equal(
      (await call("/v1/auth/accounts/complete", { token: checked.data.token, password: "replayed secure password" }))
        .status,
      400,
    );
    assert.equal(
      (await call("/v1/auth/accounts/verify", { email: "manual@example.test", password: "temporary secure password" }))
        .data.matched,
      false,
    );
    const remembered = await call("/v1/auth/broker/sessions", {
      email: "manual@example.test",
      idleS: 60,
      absoluteS: 120,
    });
    assert.equal(remembered.status, 200);
    assert.equal(
      (await call(`/v1/auth/accounts/session?email=manual@example.test&version=${change.data.version}`)).data.valid,
      true,
    );
    assert.equal(
      (
        await call(
          "/v1/admin/users/password",
          { email: "manual@example.test", password: "reset temporary password" },
          admin,
        )
      ).status,
      200,
    );
    assert.equal((await call("/v1/auth/broker/sessions/use", { token: remembered.data.token })).data.session, null);
    assert.equal(
      (await call(`/v1/auth/accounts/session?email=manual@example.test&version=${change.data.version}`)).data.valid,
      false,
    );
    const temporaryAccount = await built.accounts!.get("manual@example.test");
    assert.equal(
      (await call(`/v1/auth/accounts/session?email=manual@example.test&version=${temporaryAccount!.version}`)).data
        .valid,
      false,
    );
    assert.equal(
      (
        await call(
          `/v1/auth/accounts/session?email=manual@example.test&version=${temporaryAccount!.version}&recovery=1`,
        )
      ).data.valid,
      true,
    );
    assert.equal(
      (await call(`/v1/auth/accounts/session?email=manual@example.test&version=${change.data.version}&recovery=1`)).data
        .valid,
      false,
    );
    assert.equal((await call("/v1/admin/users/login-policy", { policy: "password" }, admin)).status, 409);
    await built.accounts!.create(admin, await hashPassword("administrator password"), false);
    assert.equal((await call("/v1/admin/users/login-policy", { policy: "password" }, admin)).status, 200);
    assert.equal((await call("/v1/auth/accounts/reset", { email: "manual@example.test" })).status, 200);
    assert.equal(sent.length, 1);
    const resetToken = new URL(sent[0]!.text.match(/https:\/\/\S+/)![0]).hash.slice("#token=".length);
    assert.equal(
      (await call("/v1/auth/accounts/complete", { token: resetToken, password: "recovered secure password" })).status,
      200,
    );
    const unknown = await call("/v1/auth/accounts/reset", { email: "unknown@example.test" });
    assert.deepEqual(unknown.data, { ok: true });
    assert.equal(sent.length, 1);
    const invitation = await call("/v1/admin/users/invite", { email: "invited@example.test" }, admin);
    assert.equal(invitation.status, 200);
    const inviteToken = new URL(sent[1]!.text.match(/https:\/\/\S+/)![0]).hash.slice("#token=".length);
    const redeemed = await call("/v1/auth/invitations/redeem", { token: inviteToken });
    assert.equal(redeemed.data.passwordSetup, true);
    assert.equal(redeemed.data.optional, false);
    assert.equal((await call("/v1/auth/accounts/complete", { token: redeemed.data.token, skip: true })).status, 400);
    assert.equal(
      (await call("/v1/auth/accounts/complete", { token: redeemed.data.token, password: "onboarding secure password" }))
        .status,
      200,
    );
    const current = await built.accounts!.get("invited@example.test");
    await call("/v1/auth/accounts/import", {
      email: "invited@example.test",
      hash: await hashPassword("legacy password value"),
    });
    assert.equal((await built.accounts!.get("invited@example.test"))!.passwordHash, current!.passwordHash);
    assert.equal(
      (
        await call(
          "/v1/admin/users/password",
          { email: "manual@example.test", password: "unauthorized password" },
          "manual@example.test",
        )
      ).status,
      403,
    );
    assert.equal((await fetch(base + "/v1/auth/accounts/policy")).status, 401);
    await call("/v1/admin/users/login-policy", { policy: "both" }, admin);
    const replaced = await call("/v1/admin/users/invite", { email: "replaced@example.test" }, admin);
    assert.equal(replaced.status, 200);
    const original = new URL(sent.at(-1)!.text.match(/https:\/\/\S+/)![0]).hash.slice("#token=".length);
    const onboarding = await call("/v1/auth/invitations/redeem", { token: original });
    assert.equal(onboarding.data.optional, true);
    await call("/v1/admin/users/invite", { email: "replaced@example.test" }, admin);
    assert.equal(
      (await call("/v1/auth/accounts/complete", { token: onboarding.data.token, password: "replaced password value" }))
        .status,
      400,
    );
    assert.equal((await call("/v1/admin/users/login-policy", { policy: "email" }, admin)).status, 200);
    assert.equal(
      (
        await call("/v1/auth/accounts/verify", {
          email: "invited@example.test",
          password: "onboarding secure password",
        })
      ).data.matched,
      false,
    );
    const listed = await call("/v1/admin/users", undefined, admin);
    assert.equal(listed.status, 200);
    assert.ok(!JSON.stringify(listed.data).includes("scrypt$"));
  },
);
