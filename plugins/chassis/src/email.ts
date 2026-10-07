import { randomBytes } from "node:crypto";
import { isMissingOrPlaceholder } from "./env.ts";
import { smtpDeliver, type SmtpOptions } from "./smtp.ts";

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: OutgoingEmail): Promise<string>;
  verify(): Promise<string>;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const RESEND_VERIFY_ENDPOINT = "https://api.resend.com/domains";
const RESEND_TIMEOUT_MS = 15_000;

export function resendMailer(cfg: EmailSettings, fetchImpl: typeof fetch = fetch): Mailer {
  const authorization = `Bearer ${cfg.resendApiKey}`;
  return {
    async send(message) {
      const r = await fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          from: cfg.emailFrom,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      const body = (await r.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
      if (!r.ok)
        throw new Error(`Resend rejected the message: HTTP ${r.status} ${body.message ?? body.name ?? ""}`.trim());
      return body.id ?? "accepted";
    },
    async verify() {
      const r = await fetchImpl(RESEND_VERIFY_ENDPOINT, {
        headers: { authorization },
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      if (r.status === 401 || r.status === 403) throw new Error("Resend rejected RESEND_API_KEY");
      if (!r.ok) throw new Error(`Resend API returned HTTP ${r.status}`);
      return "Resend API key accepted";
    },
  };
}

function smtpMailer(cfg: EmailSettings): Mailer {
  const options = { ...cfg.smtp };
  const from = senderAddress(cfg.emailFrom);
  return {
    async send(message) {
      return smtpDeliver(options, { from, to: message.to, data: renderMessage(cfg, message) });
    },
    async verify() {
      return `SMTP ${cfg.smtp.host}:${cfg.smtp.port} ${await smtpDeliver(options, null)}`;
    },
  };
}

export function mailerFor(cfg: EmailSettings): Mailer | null {
  if (!emailConfigured(cfg)) return null;
  return cfg.transport === "smtp" ? smtpMailer(cfg) : resendMailer(cfg);
}

function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n]+/g, " ").trim();
  return /^[\x20-\x7E]*$/.test(clean) ? clean : `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function base64Body(value: string): string {
  return (
    Buffer.from(value.replace(/\r?\n/g, "\r\n"), "utf8")
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  ).join("\r\n");
}

export function renderMessage(cfg: EmailSettings, message: OutgoingEmail, nowMs = Date.now()): string {
  const boundary = `qm-${randomBytes(12).toString("hex")}`;
  const domain = senderAddress(cfg.emailFrom).split("@")[1] ?? "localhost";
  const headers = [
    `From: ${encodeHeader(cfg.emailFrom)}`,
    `To: ${encodeHeader(message.to)}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${new Date(nowMs).toUTCString()}`,
    `Message-ID: <${randomBytes(16).toString("hex")}@${domain}>`,
    "MIME-Version: 1.0",
    "Auto-Submitted: auto-generated",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  return [
    headers.join("\r\n"),
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(message.text),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Body(message.html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

export interface EmailSettings {
  transport: "resend" | "smtp";
  emailFrom: string;
  resendApiKey: string;
  smtp: SmtpOptions;
}

export function readEmailSettings(env: NodeJS.ProcessEnv): EmailSettings {
  const declared = env.AUTH_EMAIL_TRANSPORT?.trim();
  if (declared && declared !== "resend" && declared !== "smtp")
    throw new Error("AUTH_EMAIL_TRANSPORT must be resend or smtp");
  const tls = env.SMTP_TLS?.trim();
  if (declared === "smtp" && tls && tls !== "starttls" && tls !== "implicit" && tls !== "none")
    throw new Error("SMTP_TLS must be starttls, implicit, or none");
  const port = env.SMTP_PORT?.trim() ? Number(env.SMTP_PORT) : 587;
  const defaultTls = port === 465 ? "implicit" : "starttls";
  return {
    transport: declared === "smtp" ? "smtp" : "resend",
    emailFrom: env.AUTH_EMAIL_FROM?.trim() ?? "",
    resendApiKey: env.RESEND_API_KEY?.trim() ?? "",
    smtp: {
      host: env.SMTP_HOST?.trim() ?? "",
      username: env.SMTP_USERNAME ?? "",
      password: env.SMTP_PASSWORD ?? "",
      port,
      tls: tls === "none" || tls === "implicit" || tls === "starttls" ? tls : defaultTls,
    },
  };
}

export function emailConfigured(cfg: EmailSettings): boolean {
  const credentials =
    cfg.transport === "resend" ? [cfg.resendApiKey] : [cfg.smtp.host, cfg.smtp.username, cfg.smtp.password];
  return [cfg.emailFrom, ...credentials].every((value) => Boolean(value.trim()));
}

export function senderAddress(from: string): string {
  const angled = /<([^>]+)>\s*$/.exec(from.trim());
  return (angled?.[1] ?? from).trim();
}

export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[^@\s,;<>"]+$/.test(value);
}

export function emailProblems(cfg: EmailSettings, isProd: boolean): string[] {
  if (!emailConfigured(cfg)) return [];
  const problems: string[] = [];
  if (
    isMissingOrPlaceholder(cfg.emailFrom) ||
    !validEmail(senderAddress(cfg.emailFrom)) ||
    /[\r\n]/.test(cfg.emailFrom)
  )
    problems.push('AUTH_EMAIL_FROM must be a verified sender address, optionally as "Name <sender@example.com>"');
  if (cfg.transport === "resend") {
    if (isMissingOrPlaceholder(cfg.resendApiKey))
      problems.push("RESEND_API_KEY is required when AUTH_EMAIL_TRANSPORT is resend");
  } else {
    for (const [name, value] of [
      ["SMTP_HOST", cfg.smtp.host],
      ["SMTP_USERNAME", cfg.smtp.username],
      ["SMTP_PASSWORD", cfg.smtp.password],
    ]) {
      if (isMissingOrPlaceholder(value)) problems.push(`${name} is required when AUTH_EMAIL_TRANSPORT is smtp`);
    }
    if (!Number.isInteger(cfg.smtp.port) || cfg.smtp.port < 1 || cfg.smtp.port > 65535)
      problems.push("SMTP_PORT must be a TCP port number");
    if (isProd && cfg.smtp.tls === "none")
      problems.push(
        "SMTP_TLS=none may not be used in production — SMTP credentials would cross the network in cleartext",
      );
  }
  return problems;
}
