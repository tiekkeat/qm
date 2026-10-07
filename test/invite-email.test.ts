import assert from "node:assert/strict";
import { test } from "node:test";
import { createInviteMailer, renderInviteEmail } from "../src/admin/invite-email.ts";
import { readEmailSettings, emailProblems, resendMailer } from "../plugins/chassis/src/email.ts";
import { loadConfig } from "../src/config.ts";
import { fakeSmtp } from "../plugins/chassis/test/fake-smtp.ts";

const env = {
  AUTH_EMAIL_FROM: "QM <sender@example.com>",
  RESEND_API_KEY: "re_key",
  SMTP_HOST: "127.0.0.1",
  SMTP_USERNAME: "user",
  SMTP_PASSWORD: "password",
};
const message = {
  to: "invitee@example.com",
  ...renderInviteEmail({
    to: "invitee@example.com",
    brandName: "QM",
    invitedBy: "admin",
    signInUrl: "https://qm.test/auth/invite#token=abc",
    expiresAt: null,
    magicLink: true,
  }),
};

test("invitation transport selection never switches to the other configured provider", () => {
  for (const transport of ["smtp", "resend"]) {
    assert.ok(createInviteMailer(readEmailSettings({ ...env, AUTH_EMAIL_TRANSPORT: transport })));
    const credentials = transport === "smtp" ? ["SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD"] : ["RESEND_API_KEY"];
    for (const name of ["AUTH_EMAIL_FROM", ...credentials])
      assert.equal(
        createInviteMailer(readEmailSettings({ ...env, AUTH_EMAIL_TRANSPORT: transport, [name]: undefined })),
        null,
      );
  }
  assert.equal(readEmailSettings({ SMTP_TLS: "invalid" }).transport, "resend");
  assert.equal(createInviteMailer(readEmailSettings({})), null);
});

test("SMTP defaults and production validation are shared with core", () => {
  assert.equal(readEmailSettings({}).smtp.port, 587);
  assert.equal(readEmailSettings({}).smtp.tls, "starttls");
  assert.equal(readEmailSettings({ SMTP_PORT: "465" }).smtp.tls, "implicit");
  for (const port of ["0", "65536", "abc", "1.5"])
    assert.throws(() => loadConfig({ ...env, AUTH_EMAIL_TRANSPORT: "smtp", SMTP_PORT: port }), /SMTP_PORT/);
  const settings = readEmailSettings({ ...env, AUTH_EMAIL_TRANSPORT: "smtp", SMTP_TLS: "none" });
  assert.equal(emailProblems(settings, false).length, 0);
  assert.match(emailProblems(settings, true).join(), /may not be used in production/);
  assert.throws(() => readEmailSettings({ AUTH_EMAIL_TRANSPORT: "invalid" }), /AUTH_EMAIL_TRANSPORT/);
  assert.throws(() => readEmailSettings({ AUTH_EMAIL_TRANSPORT: "smtp", SMTP_TLS: "invalid" }), /SMTP_TLS/);
  assert.throws(() => loadConfig({ ...env, AUTH_EMAIL_FROM: "invalid" }), /AUTH_EMAIL_FROM/);
});

test("Resend invitation transport sends its content and surfaces rejection", async () => {
  const settings = readEmailSettings(env);
  const mailer = resendMailer(settings, (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.from, env.AUTH_EMAIL_FROM);
    assert.deepEqual(body.to, [message.to]);
    assert.equal(body.html, message.html);
    assert.equal(body.text, message.text);
    return new Response(JSON.stringify({ id: "sent" }));
  }) as typeof fetch);
  assert.equal(await mailer.send(message), "sent");
  await assert.rejects(
    () =>
      resendMailer(
        settings,
        (async () => new Response(JSON.stringify({ message: "bad key" }), { status: 403 })) as typeof fetch,
      ).send(message),
    /Resend rejected.*bad key/,
  );
});

test("SMTP invitation failures do not trigger Resend", async (t) => {
  const smtp = await fakeSmtp({ rejectRecipient: true });
  t.after(() => smtp.close());
  const settings = readEmailSettings({
    ...env,
    AUTH_EMAIL_TRANSPORT: "smtp",
    SMTP_PORT: String(smtp.port),
    SMTP_TLS: "none",
  });
  await assert.rejects(() => createInviteMailer(settings)!.send(message), /SMTP RCPT rejected/);
  assert.equal(smtp.messages.length, 0);
  const starttls = { ...settings, smtp: { ...settings.smtp, tls: "starttls" as const } };
  await assert.rejects(() => createInviteMailer(starttls)!.send(message), /does not offer STARTTLS/);
});
