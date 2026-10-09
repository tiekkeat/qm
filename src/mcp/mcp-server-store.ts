import { encryptSecret, decryptSecret, type SecretKey } from "../connectors/connector-client-store.ts";
// Registry of admin-configured MCP servers.
//
// Admin-only by design: registering a server points every scope's agents at
// an outbound HTTP endpoint, so end users must not be able to add one (SSRF
// and exfiltration surface). Secrets live in the record like other stored
// connector credentials — reachable only through core, never injected into sandboxes.

import type { DurableMap } from "../persistence/durable-map.ts";

export type McpServerAuthMode = "none" | "bearer" | "client-credentials";

export interface McpServer {
  id: string;
  name: string;
  url: string;
  auth: McpServerAuthMode;
  credentialScope?: "shared" | "per-user";
  credentialHost?: string;
  credentialAccountType?: "default" | "personal" | "company";
  secretEnc?: string;
  bearerToken?: string;
  clientId?: string;
  clientSecret?: string;
  readOnly: boolean;
  enabled: boolean;
  updatedAt: number;
  updatedBy: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

export function isValidMcpServerId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export interface McpServerStore {
  list(): Promise<McpServer[]>;
  get(id: string): Promise<McpServer | null>;
  put(server: McpServer): Promise<void>;
  delete(id: string): Promise<void>;
  onChange(listener: () => void): () => void;
}

export function createMcpServerStore(backing: DurableMap<McpServer>, key?: SecretKey): McpServerStore {
  function encrypted(server: McpServer): McpServer {
    if (!key || (!server.bearerToken && !server.clientSecret)) return server;
    const { bearerToken, clientSecret, ...record } = server;
    return { ...record, secretEnc: encryptSecret(JSON.stringify({ bearerToken, clientSecret }), key) };
  }
  function decrypted(server: McpServer): McpServer {
    if (!server.secretEnc) return server;
    if (!key) throw new Error("Persistent connector encryption is required to read MCP credentials");
    const { secretEnc, ...record } = server;
    return { ...record, ...JSON.parse(decryptSecret(secretEnc, key)) };
  }
  async function read(id: string): Promise<McpServer | null> {
    let server = await backing.get(id);
    if (server && key && (server.bearerToken || server.clientSecret) && backing.update)
      server = await backing.update(id, encrypted);
    return server ? decrypted(server) : null;
  }
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    async list() {
      const entries = await backing.entries();
      const servers = await Promise.all(entries.map(([id]) => read(id)));
      return servers.filter((server) => server !== null).sort((a, b) => a.id.localeCompare(b.id));
    },
    get: read,
    put: async (server) => {
      await backing.put(server.id, encrypted(server));
      emit();
    },
    delete: async (id) => {
      await backing.delete(id);
      emit();
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
