import type { DerivedOAuthAuth, Keychain } from "../credentials/keychain.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { personKey } from "../directory/person.ts";
import { createMemoryAdvisoryLock, type AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { ModelProvider } from "./pi-models.ts";

type UserCredentialKind = "apikey" | "oauth";

export interface UserOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
  expiresAt?: number;
}

/** Connection summary. Never carries token material. */
export interface UserModelCredential {
  provider: ModelProvider;
  kind: UserCredentialKind;
  apiKey?: string;
  oauth?: { accountId?: string; expiresAt?: number; needsReconnect?: boolean };
  updatedAt: number;
}

interface UserCredentialConnection {
  provider: ModelProvider;
  kind: UserCredentialKind;
}

export interface UserModelCredentialStore {
  get(userId: string, provider: ModelProvider): Promise<UserModelCredential | null>;
  connections(userId: string): Promise<UserCredentialConnection[]>;
  setApiKey(userId: string, provider: ModelProvider, apiKey: string): Promise<void>;
  setOAuth(userId: string, provider: ModelProvider, tokens: UserOAuthTokens): Promise<void>;
  /**
   * Fresh derived material for the user's subscription login (access + id
   * token + account id) — refreshed inside the keychain (single-flight, CAS)
   * when stale. The refresh token never leaves the keychain record.
   */
  derivedOAuth(userId: string, provider: ModelProvider): Promise<DerivedOAuthAuth | null>;
  delete(userId: string, provider: ModelProvider): Promise<void>;
  sharedStatus(): Promise<{ connected: boolean; needsReconnect?: boolean; grantees: string[] }>;
  setSharedOAuth(tokens: UserOAuthTokens): Promise<void>;
  completeSharedLogin(id: string, tokens: UserOAuthTokens): Promise<boolean>;
  deleteSharedOAuth(): Promise<void>;
  setSharedGrant(userId: string, enabled: boolean): Promise<void>;
  hasSharedGrant(userId: string): Promise<boolean>;
  sharedOAuth(userId: string): Promise<DerivedOAuthAuth | null>;
  putSharedLogin(id: string, actorId: string, expiresAt: number): Promise<void>;
  getSharedLogin(id: string): Promise<SharedCodexLogin | null>;
  finishSharedLogin(id: string, status: "connected" | "failed"): Promise<void>;
  deleteSharedLogin(id: string): Promise<void>;
}

export interface SharedCodexLogin {
  id: string;
  actorId: string;
  expiresAt: number;
  status: "pending" | "connected" | "failed";
}

const PROVIDERS: ModelProvider[] = ["anthropic", "openai"];
const ORIGIN = "individual-model-auth";
/**
 * OAuth logins are keyed by the provider's auth host, so the keychain's own
 * connector-token machinery (encryption, expiry margin, single-flight refresh
 * via the wired refresh dispatch) covers them with no parallel implementation.
 */
const AI_OAUTH_HOSTS: Record<"anthropic" | "openai", string> = {
  anthropic: "claude.ai",
  openai: "auth.openai.com",
};
/** Segregates AI subscription logins from any other connector use of the same host. */
const AI_ACCOUNT_TYPE = "individual-model";
const SHARED_ACCOUNT_TYPE = "shared-model";
const SHARED_OWNER = "org-codex-model";
const SHARED_HOST = "auth.openai.com";

function serviceFor(provider: ModelProvider): string {
  return `model-${provider}`;
}

function oauthHostFor(provider: ModelProvider): string | null {
  return provider === "anthropic" || provider === "openai" ? AI_OAUTH_HOSTS[provider] : null;
}

/**
 * Per-user AI-account custody, backed by the org keychain — NOT a parallel
 * secret store.
 *
 * - Subscription (OAuth) logins are keychain connector tokens: the keychain
 *   encrypts them, tracks expiry, and refreshes them centrally; callers only
 *   ever receive derived material without the refresh token.
 * - API keys are ordinary keychain credentials owned by the user (service
 *   `model-<provider>`, origin `individual-model-auth`), so admin visibility
 *   and "remove my credentials" apply.
 */
export function createUserModelCredentialStore(input: {
  keychain: Keychain;
  sharedGrants?: DurableMap<{ userId: string; enabled: boolean }>;
  sharedLogins?: DurableMap<SharedCodexLogin>;
  lock?: AdvisoryLock;
}): UserModelCredentialStore {
  const { keychain } = input;
  const sharedGrants = input.sharedGrants ?? createMemoryMap<{ userId: string; enabled: boolean }>();
  const sharedLogins = input.sharedLogins ?? createMemoryMap<SharedCodexLogin>();
  const lock = input.lock ?? createMemoryAdvisoryLock();

  async function findApiKey(userId: string, provider: ModelProvider) {
    const all = await keychain.listByOwner(userId);
    return all.find((c) => c.service === serviceFor(provider) && c.origin === ORIGIN) ?? null;
  }

  async function oauthCredential(userId: string, provider: ModelProvider): Promise<UserModelCredential | null> {
    const host = oauthHostFor(provider);
    if (!host) return null;
    const status = await keychain.connectorTokenStatus(host, userId, AI_ACCOUNT_TYPE);
    if (!status.connected) return null;
    return {
      provider,
      kind: "oauth",
      oauth: {
        ...(status.expiresAt !== undefined ? { expiresAt: status.expiresAt } : {}),
        ...(status.needsReconnect ? { needsReconnect: true } : {}),
      },
      updatedAt: 0,
    };
  }

  async function apiKeyCredential(userId: string, provider: ModelProvider): Promise<UserModelCredential | null> {
    const meta = await findApiKey(userId, provider);
    if (!meta) return null;
    const apiKey = await keychain.readOwnSecret(userId, meta.id);
    if (!apiKey) return null;
    return { provider, kind: "apikey", apiKey, updatedAt: meta.updatedAt };
  }

  return {
    async get(userId, provider) {
      return (await oauthCredential(userId, provider)) ?? (await apiKeyCredential(userId, provider));
    },

    async connections(userId) {
      const found: UserCredentialConnection[] = [];
      for (const provider of PROVIDERS) {
        const cred = (await oauthCredential(userId, provider)) ?? (await apiKeyCredential(userId, provider));
        if (cred) found.push({ provider, kind: cred.kind });
      }
      return found;
    },

    async setApiKey(userId, provider, apiKey) {
      const secret = apiKey.trim();
      if (!secret) throw new Error("API key is required");
      // One connection per provider: an API key replaces a subscription login.
      const host = oauthHostFor(provider);
      if (host) await keychain.deleteConnectorToken(host, userId, AI_ACCOUNT_TYPE);
      await keychain.save({ ownerId: userId, service: serviceFor(provider), secret, origin: ORIGIN });
    },

    async setOAuth(userId, provider, tokens) {
      if (!tokens.accessToken?.trim()) throw new Error("access token is required");
      const host = oauthHostFor(provider);
      if (!host) throw new Error(`no subscription login host for provider ${provider}`);
      await keychain.setConnectorToken(
        host,
        userId,
        {
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
          ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
          ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
        },
        AI_ACCOUNT_TYPE,
      );
      // One connection per provider: a subscription login replaces an API key.
      const apiKeyMeta = await findApiKey(userId, provider);
      if (apiKeyMeta) await keychain.remove(userId, apiKeyMeta.id);
    },

    async derivedOAuth(userId, provider) {
      const host = oauthHostFor(provider);
      if (!host) return null;
      return keychain.connectorDerivedAuth(host, userId, AI_ACCOUNT_TYPE);
    },

    async delete(userId, provider) {
      const host = oauthHostFor(provider);
      if (host) await keychain.deleteConnectorToken(host, userId, AI_ACCOUNT_TYPE);
      const meta = await findApiKey(userId, provider);
      if (meta) await keychain.remove(userId, meta.id);
    },

    async sharedStatus() {
      const status = await keychain.connectorTokenStatus(SHARED_HOST, SHARED_OWNER, SHARED_ACCOUNT_TYPE);
      const grants = await sharedGrants.all();
      return {
        connected: status.connected,
        ...(status.needsReconnect ? { needsReconnect: true } : {}),
        grantees: grants.filter((row) => row.enabled).map((row) => row.userId),
      };
    },

    async setSharedOAuth(tokens) {
      if (!tokens.accessToken || !tokens.refreshToken || !tokens.idToken)
        throw new Error("ChatGPT device login returned incomplete credentials");
      await keychain.setConnectorToken(
        SHARED_HOST,
        SHARED_OWNER,
        {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          idToken: tokens.idToken,
          ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
          ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
        },
        SHARED_ACCOUNT_TYPE,
      );
    },

    async deleteSharedOAuth() {
      await lock.withLock("shared-codex-login", async () => {
        for (const row of await sharedLogins.all()) await sharedLogins.delete(row.id);
        await keychain.deleteConnectorToken(SHARED_HOST, SHARED_OWNER, SHARED_ACCOUNT_TYPE);
      });
    },

    async completeSharedLogin(id, tokens) {
      return lock.withLock("shared-codex-login", async () => {
        if ((await this.getSharedLogin(id))?.status !== "pending") return false;
        await this.setSharedOAuth(tokens);
        await this.finishSharedLogin(id, "connected");
        return true;
      });
    },

    async setSharedGrant(userId, enabled) {
      const id = personKey(userId);
      if (!id) throw new Error("userId is required");
      await sharedGrants.put(id, { userId: id, enabled });
    },

    async hasSharedGrant(userId) {
      return (await sharedGrants.get(personKey(userId)))?.enabled === true;
    },

    async sharedOAuth(userId) {
      if (!(await this.hasSharedGrant(userId))) return null;
      return keychain.connectorDerivedAuth(SHARED_HOST, SHARED_OWNER, SHARED_ACCOUNT_TYPE);
    },

    async putSharedLogin(id, actorId, expiresAt) {
      for (const old of await sharedLogins.all()) {
        if (old.expiresAt < Date.now()) await sharedLogins.delete(old.id);
      }
      await sharedLogins.put(id, { id, actorId, expiresAt, status: "pending" });
    },

    async getSharedLogin(id) {
      const row = await sharedLogins.get(id);
      return row && row.expiresAt >= Date.now() ? row : null;
    },

    async finishSharedLogin(id, status) {
      await sharedLogins.merge(id, { status });
    },

    async deleteSharedLogin(id) {
      await sharedLogins.delete(id);
    },

  };
}
