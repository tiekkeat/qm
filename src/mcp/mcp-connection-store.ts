import type { DurableMap } from "../persistence/durable-map.ts";
import type { McpToolDescriptor } from "./mcp-tool-service.ts";

export type McpAuthentication = "none" | "bearer" | "client-credentials" | "oauth";
export interface McpAccess {
  scopeId: string;
  tools: string[];
  write: boolean;
  unattended: boolean;
  account: "own" | "saved";
  accountOwner?: string;
}
export interface McpConnection {
  id: string;
  name: string;
  url: string;
  auth: McpAuthentication;
  ownerScopeId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  enabled: boolean;
  blockedByAdmin?: boolean;
  tools: Array<McpToolDescriptor & { approved: boolean }>;
  unattended: boolean;
  lastTest?: { at: number; ok: boolean };
  homeAccountOwner?: string;
  shares: McpAccess[];
}
export interface McpAccount {
  connectionId: string;
  principalId: string;
  version: number;
  secretEnc: string;
  updatedAt: number;
}
export interface McpOAuthFlow {
  connectionId: string;
  principalId: string;
  version: number;
  secretEnc: string;
  issuedAt: number;
}
export interface McpConnectionStores {
  connections: DurableMap<McpConnection>;
  accounts: DurableMap<McpAccount>;
  flows: DurableMap<McpOAuthFlow>;
}
