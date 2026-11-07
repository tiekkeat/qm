import { accessExpiresAt, chatgptAuthFromFiles } from "../model/chatgpt-auth-file.ts";
import { refreshChatGPTTokens } from "../model/subscription-oauth.ts";
import type { UserOAuthTokens } from "../model/user-model-credential-store.ts";
import { chatgptAuthFromValue as codexOAuthAuthFromValue } from "../model/chatgpt-auth-file.ts";
import { asObject, codexOAuthJwtAccountId, type JsonObject } from "./codex-auth-file.ts";
import { codexOAuthRefreshToken, readCodexOAuthAuthFile, sanitizedCodexOAuthAuth } from "./codex-auth-file.ts";
import type { Keychain } from "../credentials/keychain.ts";
import { swallow } from "../util/errors.ts";
import { acquireCodexOAuthAuthLock, writeCodexOAuthAuthFile } from "./codex-auth.ts";

export interface CodexAuthStore {
  readonly description: string;

  load(): Promise<JsonObject | null>;
}

const REFRESH_SKEW_MS = 5 * 60_000;

export function codexOAuthAccessTokenExpiresAt(auth: JsonObject | null): number | undefined {
  return auth ? accessExpiresAt(auth) : undefined;
}

export { chatgptAuthFromValue as codexOAuthAuthFromValue } from "../model/chatgpt-auth-file.ts";

export function childCodexAuthFromDerived(derived: {
  accessToken: string;
  idToken: string;
  accountId?: string;
}): JsonObject | null {
  const auth: JsonObject = {
    auth_mode: "chatgpt",
    tokens: {
      access_token: derived.accessToken,
      refresh_token: "",
      id_token: derived.idToken,
      ...(derived.accountId ? { account_id: derived.accountId } : {}),
    },
  };
  if (!derived.accessToken || !codexOAuthJwtAccountId(auth)) return null;
  return auth;
}

export function childCodexOAuthAuth(auth: JsonObject): JsonObject {
  const sanitized = sanitizedCodexOAuthAuth(auth);
  const tokens = asObject(sanitized.tokens);
  if (tokens) {
    const { refresh_token: _refresh, ...rest } = tokens;
    sanitized.tokens = { ...rest, refresh_token: "" };
  }

  sanitized.last_refresh = new Date().toISOString();
  return sanitized;
}

async function refreshCodexOAuth(
  auth: JsonObject,
  refresh: (refreshToken: string) => Promise<UserOAuthTokens>,
): Promise<JsonObject | null> {
  const refreshToken = codexOAuthRefreshToken(auth);
  if (!refreshToken) return null;
  const body = await refresh(refreshToken);
  const tokens = asObject(auth.tokens) ?? {};
  const next: JsonObject = {
    ...auth,
    last_refresh: new Date().toISOString(),
    tokens: {
      ...tokens,
      access_token: body.accessToken,
      ...(body.idToken ? { id_token: body.idToken } : {}),
      ...(body.refreshToken ? { refresh_token: body.refreshToken } : {}),
    },
  };

  return codexOAuthAuthFromValue(next) && codexOAuthJwtAccountId(next) === codexOAuthJwtAccountId(auth) ? next : null;
}

function authNeedsRefresh(auth: JsonObject, now: number): boolean {
  const expiresAt = codexOAuthAccessTokenExpiresAt(auth);
  return typeof expiresAt === "number" && expiresAt - now < REFRESH_SKEW_MS;
}

interface KeychainCodexAuthStoreDeps {
  keychain: Keychain;

  credentialId: string;
  fetchImpl?: typeof fetch;
  refresh?: (refreshToken: string) => Promise<UserOAuthTokens>;
  now?: () => number;
}

export function keychainCodexAuthStore(deps: KeychainCodexAuthStoreDeps): CodexAuthStore {
  const refresh = deps.refresh ?? ((refreshToken: string) => refreshChatGPTTokens(refreshToken, deps.fetchImpl));
  let cached: { revision: string; found: { path: string; auth: JsonObject } | null } | undefined;
  const now = deps.now ?? Date.now;
  let refreshing: Promise<JsonObject | null> | null = null;

  const readCurrent = async (): Promise<{
    ownerId: string;
    service: string;
    path: string;
    auth: JsonObject;
  } | null> => {
    const meta = await deps.keychain.getCredential(deps.credentialId);
    if (!meta || meta.kind !== "file") return null;
    const revision = `${meta.ownerId}:${meta.fingerprint}:${meta.updatedAt}`;
    if (cached?.revision !== revision) {
      const bundles = await deps.keychain.materializeOwnFiles(meta.ownerId);
      const bundle = bundles.find((b) => b.credentialId === deps.credentialId);
      cached = { revision, found: bundle ? chatgptAuthFromFiles(bundle.files) : null };
    }
    const found = cached.found;
    return found ? { ownerId: meta.ownerId, service: meta.service, ...found } : null;
  };

  const persist = async (
    current: { ownerId: string; service: string; path: string },
    replacedRefreshToken: string | undefined,
    next: JsonObject,
  ): Promise<boolean> => {
    const latest = await readCurrent();
    if (!latest || codexOAuthRefreshToken(latest.auth) !== replacedRefreshToken) return false;
    await deps.keychain.save({
      ownerId: current.ownerId,
      service: current.service,
      files: [{ path: current.path, contentBase64: Buffer.from(JSON.stringify(next), "utf8").toString("base64") }],
      ...(codexOAuthAccessTokenExpiresAt(next) !== undefined
        ? { expiresAt: codexOAuthAccessTokenExpiresAt(next) }
        : {}),
    });
    return true;
  };

  return {
    description: `keychain credential ${deps.credentialId}`,
    async load(): Promise<JsonObject | null> {
      const current = await readCurrent();
      if (!current) return null;
      if (!authNeedsRefresh(current.auth, now())) return current.auth;

      refreshing ??= (async () => {
        try {
          const next = await refreshCodexOAuth(current.auth, refresh);
          if (!next) return null;
          return (await persist(current, codexOAuthRefreshToken(current.auth), next))
            ? next
            : ((await readCurrent())?.auth ?? null);
        } finally {
          refreshing = null;
        }
      })();
      try {
        const refreshed = await refreshing;
        if (refreshed) return refreshed;
      } catch (error) {
        swallow("codex: central oauth refresh", error);
      }

      return (await readCurrent())?.auth ?? current.auth;
    },
  };
}

export function fileCodexAuthStore(
  path: string,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): CodexAuthStore {
  let refreshing: Promise<JsonObject | null> | null = null;
  return {
    description: `auth file ${path}`,
    async load(): Promise<JsonObject | null> {
      const current = readCodexOAuthAuthFile(path);
      if (!current) return null;
      if (!authNeedsRefresh(current, now())) return current;
      refreshing ??= (async () => {
        try {
          const next = await refreshCodexOAuth(current, (refreshToken) =>
            refreshChatGPTTokens(refreshToken, fetchImpl),
          );
          if (!next) return null;
          const lock = await acquireCodexOAuthAuthLock(path, undefined, 10_000, 25);
          try {
            const latest = readCodexOAuthAuthFile(path);

            if (!latest || codexOAuthRefreshToken(latest) !== codexOAuthRefreshToken(current)) return latest;
            writeCodexOAuthAuthFile(path, next);
          } finally {
            await lock.release();
          }
          return next;
        } finally {
          refreshing = null;
        }
      })();
      try {
        const refreshed = await refreshing;
        if (refreshed) return refreshed;
      } catch (error) {
        swallow("codex: file oauth refresh", error);
      }
      return readCodexOAuthAuthFile(path) ?? current;
    },
  };
}
