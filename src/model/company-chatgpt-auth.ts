import type { Keychain } from "../credentials/keychain.ts";
import { keychainCodexAuthStore } from "../harness/codex-auth-store.ts";
import { accessExpiresAt, authTokens, loadCodexAuthFile } from "./chatgpt-auth-file.ts";
import type { UserOAuthTokens } from "./user-model-credential-store.ts";

export interface CompanyChatGPTAuth {
  readonly description: string;
  accessToken(): Promise<string | undefined>;
}

export function fileCompanyChatGPTAuth(path: string): CompanyChatGPTAuth {
  return {
    description: `auth file ${path}`,
    async accessToken() {
      const auth = loadCodexAuthFile(path);
      const expiresAt = accessExpiresAt(auth);
      if (expiresAt !== undefined && expiresAt <= Date.now())
        throw new Error(`the ChatGPT login in ${path} has expired; run the Codex CLI to refresh it`);
      return authTokens(auth)?.access;
    },
  };
}

export function keychainCompanyChatGPTAuth(deps: {
  keychain: Keychain;
  credentialId: string;
  refresh?: (refreshToken: string) => Promise<UserOAuthTokens>;
  now?: () => number;
}): CompanyChatGPTAuth {
  const store = keychainCodexAuthStore(deps);
  return {
    description: store.description,
    async accessToken() {
      const auth = await store.load();
      return auth ? authTokens(auth)?.access : undefined;
    },
  };
}
