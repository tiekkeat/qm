import { fetchCoreText } from "./core-client.ts";

export type LoginPolicy = "both" | "password" | "email";
export interface AccountInfo {
  email: string;
  hasPassword: boolean;
  mustChangePassword: boolean;
  version: number;
}
export interface PasswordTicket {
  email: string;
  kind: "setup" | "change" | "reset";
  version: number;
  inviteId?: string;
}
export interface PasswordVerification {
  matched: boolean;
  managed?: boolean;
  mustChangePassword?: boolean;
  token?: string;
}
export interface AccountClient {
  request<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T>;
}
export class AccountRequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function coreAccounts(baseUrl: string, secret?: string): AccountClient {
  return {
    async request<T>(path: string, data?: unknown, headers?: Record<string, string>): Promise<T> {
      const result = await fetchCoreText({
        origin: baseUrl,
        secret,
        method: data === undefined ? "GET" : "POST",
        path: `/v1/auth/accounts${path}`,
        body: data === undefined ? undefined : JSON.stringify(data),
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      const parsed = JSON.parse(result.text) as { message?: string };
      if (result.status < 200 || result.status >= 300)
        throw new AccountRequestError(result.status, parsed.message ?? "Account service unavailable");
      return parsed as T;
    },
  };
}
