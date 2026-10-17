import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type JsonObject = Record<string, unknown>;

function decodeJwtClaims(jwt: string | undefined): Record<string, unknown> | undefined {
  if (!jwt) return undefined;
  const part = jwt.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

export function chatgptAccountIdFromToken(jwt: unknown): string | undefined {
  if (typeof jwt !== "string" || jwt.split(".").length !== 3) return undefined;
  const auth = decodeJwtClaims(jwt)?.["https://api.openai.com/auth"];
  const accountId = auth && typeof auth === "object" ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
  return typeof accountId === "string" && accountId ? accountId : undefined;
}

export function tokenExpiry(raw: { expires_in?: number; access_token?: string }): number | undefined {
  if (typeof raw.expires_in === "number") return Date.now() + raw.expires_in * 1000;
  const claims = decodeJwtClaims(raw.access_token);
  const exp = claims?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

export function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

export function authTokens(auth: JsonObject): { access: string; refresh: string; id?: string } | null {
  const tokens = asObject(auth.tokens);
  if (!tokens || typeof tokens.access_token !== "string" || !tokens.access_token) return null;
  if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) return null;
  return {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    ...(typeof tokens.id_token === "string" && tokens.id_token ? { id: tokens.id_token } : {}),
  };
}

export function authAccountId(auth: JsonObject): string | undefined {
  const tokens = asObject(auth.tokens);
  return tokens
    ? (chatgptAccountIdFromToken(tokens.id_token) ?? chatgptAccountIdFromToken(tokens.access_token))
    : undefined;
}

export function accessExpiresAt(auth: JsonObject): number | undefined {
  return tokenExpiry({ access_token: authTokens(auth)?.access });
}

export function chatgptAuthFromValue(value: unknown): JsonObject | null {
  const auth = asObject(value);
  if (!auth || (auth.auth_mode !== "chatgpt" && auth.auth_mode !== "chatgptAuthTokens")) return null;
  return authTokens(auth) && authAccountId(auth) ? auth : null;
}

function expandPath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return resolve(path);
}

export function codexAuthFileForEnv(env: NodeJS.ProcessEnv, includeDefault = false): string | undefined {
  const explicit = env.CODEX_AUTH_FILE?.trim();
  if (explicit) return expandPath(explicit);
  if (!includeDefault) return undefined;
  const codexHome = env.CODEX_HOME?.trim();
  if (codexHome) return join(expandPath(codexHome), "auth.json");
  const home = env.HOME?.trim();
  return home ? join(expandPath(home), ".codex", "auth.json") : undefined;
}

export function loadCodexAuthFile(path: string): JsonObject {
  if (statSync(path).mode & 0o077) throw new Error(`${path} must not be readable by group or others (chmod 600 it)`);
  const auth = chatgptAuthFromValue(JSON.parse(readFileSync(path, "utf8")));
  if (!auth) throw new Error(`${path} is not a ChatGPT login auth.json`);
  return auth;
}

export function readCodexOAuthAuthFile(path: string): JsonObject | null {
  try {
    return loadCodexAuthFile(path);
  } catch {
    return null;
  }
}

export function chatgptAuthFromFiles(
  files: readonly { path: string; contentBase64: string }[],
): { path: string; auth: JsonObject } | null {
  for (const file of files) {
    const normalized = file.path.replace(/^\.\//, "");
    if (![".codex/auth.json", "codex/auth.json"].includes(normalized) && !normalized.endsWith("/auth.json")) continue;
    try {
      const auth = chatgptAuthFromValue(JSON.parse(Buffer.from(file.contentBase64, "base64").toString("utf8")));
      if (auth) return { path: file.path, auth };
    } catch {
      continue;
    }
  }
  return null;
}
