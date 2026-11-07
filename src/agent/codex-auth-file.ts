import { asObject, type JsonObject } from "../model/chatgpt-auth-file.ts";
export {
  asObject,
  authAccountId as codexOAuthJwtAccountId,
  codexAuthFileForEnv,
  readCodexOAuthAuthFile,
  type JsonObject,
} from "../model/chatgpt-auth-file.ts";

export function sanitizedCodexOAuthAuth(auth: JsonObject): JsonObject {
  const copy: JsonObject = {};
  for (const key of ["auth_mode", "last_refresh", "tokens"] as const) {
    if (key === "tokens") {
      const tokens = asObject(auth.tokens);
      if (tokens) {
        copy.tokens = Object.fromEntries(
          ["access_token", "refresh_token", "id_token", "account_id"].flatMap((token) =>
            typeof tokens[token] === "string" ? [[token, tokens[token]]] : [],
          ),
        );
      }
    } else if (key in auth) copy[key] = auth[key];
  }
  return copy;
}

export function codexOAuthRefreshToken(value: unknown): string | undefined {
  const auth = asObject(value);
  const tokens = auth ? asObject(auth.tokens) : null;
  return typeof tokens?.refresh_token === "string" && tokens.refresh_token ? tokens.refresh_token : undefined;
}
