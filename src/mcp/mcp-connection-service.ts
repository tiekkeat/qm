import { randomUUID, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  auth as authorize,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { encryptSecret, decryptSecret, type SecretKey } from "../connectors/connector-client-store.ts";
import type { McpConnection, McpConnectionStores, McpAccess, McpAuthentication } from "./mcp-connection-store.ts";
import { McpEndpointPolicyError, type McpNetworkPolicy } from "./mcp-endpoint-policy.ts";
import type { AclStore } from "../acl/acl-store.ts";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import type { ProjectStore } from "../projects/project-store.ts";
import { projectIdFromGroupRef, projectScopeId } from "../projects/project-store.ts";
import { parseScopeId, scopeId, type Principal } from "../types.ts";
import { samePerson, personKey } from "../directory/person.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { mcpResultText } from "./mcp-client.ts";
import type { McpToolDescriptor, McpToolService } from "./mcp-tool-service.ts";

interface AccountSecret {
  bearerToken?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokenExpiresAt?: number;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
  tokenUrl?: string;
  tools?: McpToolDescriptor[];
}
export interface McpExecutionContext {
  principalId: string;
  scopeId: string;
  audience: Principal[];
  unattended: boolean;
  readOnly?: boolean;
}
export interface McpConnectionInput {
  name: string;
  url: string;
  auth: McpAuthentication;
  ownerScopeId?: string;
  enabled?: boolean;
  unattended?: boolean;
  tools?: Array<{ name: string; approved: boolean; readOnly: boolean }>;
  homeAccountOwner?: string | null;
}
export interface McpAccountInput {
  bearerToken?: string;
  clientId?: string;
  clientSecret?: string;
  issuer?: string;
  tokenUrl?: string;
}

export class McpAccessError extends Error {
  constructor(message = "MCP connection not found or access removed") {
    super(message);
  }
}

export function createMcpConnectionService(opts: {
  stores: McpConnectionStores;
  acl: AclStore;
  projects: ProjectStore;
  policy: McpNetworkPolicy;
  key?: SecretKey;
  lock: AdvisoryLock;
  audit: AuditLog;
  active: (principalId: string) => Promise<boolean>;
  recipient?: (principalId: string) => Promise<boolean>;
  callbackUrl: string;
}) {
  const { stores, projects, acl, policy, lock } = opts;
  const ref = (id: string) => `mcp:${id}`;
  const toolName = (id: string, remote: string) => {
    const plain = `${id}_${remote}`;
    return plain.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(plain)
      ? plain
      : `${id}_${remote.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 19)}_${createHash("sha256").update(remote).digest("hex").slice(0, 8)}`;
  };
  const sameScope = (a: string, b: string) => {
    const left = parseScopeId(a);
    const right = parseScopeId(b);
    return left.kind === "personal" && right.kind === "personal" ? samePerson(left.ref, right.ref) : a === b;
  };
  const validateConnectionUrl = async (url: string) => {
    if (new URL(url).search)
      throw new Error("Server URLs must not contain query parameters; connect credentials separately");
    await policy.validate(url);
  };
  const accountId = (id: string, actor: string) => `${id}:${personKey(actor)}`;
  const decode = (secretEnc: string): AccountSecret => {
    if (!opts.key) throw new Error("Persistent connector encryption is required for MCP accounts");
    return JSON.parse(decryptSecret(secretEnc, opts.key));
  };
  const encode = (secret: AccountSecret): string => {
    if (!opts.key) throw new Error("Persistent connector encryption is required for MCP accounts");
    return encryptSecret(JSON.stringify(secret), opts.key);
  };
  function audit(action: string, connection: McpConnection, actor: string, status = "ok", accountOwner?: string) {
    opts.audit.record({
      at: Date.now(),
      principalId: actor,
      action: `mcp.${action}`,
      resource: connection.id,
      scopeLabel: connection.ownerScopeId,
      status: accountOwner ? `${status} accountOwner=${accountOwner}` : status,
    });
  }
  async function member(actor: string, scope: string): Promise<boolean> {
    if (!(await opts.active(actor))) return false;
    const parsed = parseScopeId(scope);
    if (parsed.kind === "personal") return samePerson(actor, parsed.ref);
    const id = parsed.kind === "group" ? projectIdFromGroupRef(parsed.ref) : null;
    return id ? (await projects.membership(parsed.ref, actor)) === true : false;
  }
  async function manager(actor: string, connection: McpConnection): Promise<boolean> {
    if (!(await opts.active(actor))) return false;
    const home = parseScopeId(connection.ownerScopeId);
    if (home.kind === "personal") return samePerson(actor, home.ref);
    const id = home.kind === "group" ? projectIdFromGroupRef(home.ref) : null;
    const project = id ? await projects.get(id) : null;
    return !!project && samePerson(project.ownerId, actor);
  }
  async function access(connection: McpConnection, actor: string): Promise<McpAccess[]> {
    if (!(await opts.active(actor))) return [];
    const grants = await acl.grantsFor(connection.ownerScopeId, ref(connection.id));
    const valid: McpAccess[] = [];
    if (await member(actor, connection.ownerScopeId))
      valid.push({
        scopeId: connection.ownerScopeId,
        tools: connection.tools.filter((tool) => tool.approved).map((tool) => tool.remoteName),
        write: true,
        unattended: connection.unattended,
        account: connection.homeAccountOwner ? "saved" : "own",
        accountOwner: connection.homeAccountOwner,
      });
    for (const share of connection.shares) {
      if (grants.some((grant) => grant.granteeScopeId === share.scopeId) && (await member(actor, share.scopeId)))
        valid.push(share);
    }
    return valid;
  }
  async function requireAccess(id: string, actor: string, manage = false): Promise<McpConnection> {
    const connection = await stores.connections.get(id);
    if (!connection || !(manage ? await manager(actor, connection) : (await access(connection, actor)).length > 0))
      throw new McpAccessError();
    return structuredClone(connection);
  }
  async function account(connection: McpConnection, actor: string): Promise<AccountSecret | null> {
    const stored = await stores.accounts.get(accountId(connection.id, actor));
    return stored?.version === connection.version ? decode(stored.secretEnc) : null;
  }
  async function saveAccount(connection: McpConnection, actor: string, secret: AccountSecret) {
    const current = await stores.connections.get(connection.id);
    if (!current || current.version !== connection.version)
      throw new McpAccessError("MCP configuration changed; reconnect your account");
    await stores.accounts.put(accountId(connection.id, actor), {
      connectionId: connection.id,
      principalId: actor,
      version: connection.version,
      secretEnc: encode(secret),
      updatedAt: Date.now(),
    });
  }
  const clientMetadata = () => ({
    client_name: "QM MCP",
    redirect_uris: [opts.callbackUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
  function provider(
    connection: McpConnection,
    secret: AccountSecret,
    save: () => Promise<void>,
    state?: string,
    redirect?: (url: string) => Promise<void>,
  ): OAuthClientProvider {
    return {
      redirectUrl: opts.callbackUrl,
      ...(opts.callbackUrl.startsWith("https:")
        ? { clientMetadataUrl: new URL("client-metadata", opts.callbackUrl).href }
        : {}),
      clientMetadata: {
        client_name: "QM MCP",
        redirect_uris: [opts.callbackUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: secret.client?.client_secret ? "client_secret_post" : "none",
      },
      state: () => {
        if (!state) throw new Error("Reconnect your MCP account");
        return state;
      },
      clientInformation: () => secret.client,
      saveClientInformation: async (client) => {
        secret.client = client;
        await save();
      },
      tokens: () => secret.tokens,
      saveTokens: async (tokens) => {
        secret.tokens = { ...tokens, refresh_token: tokens.refresh_token ?? secret.tokens?.refresh_token };
        secret.tokenExpiresAt =
          typeof tokens.expires_in === "number" ? Date.now() + tokens.expires_in * 1000 : undefined;
        await save();
      },
      redirectToAuthorization: async (url) => {
        if (!redirect) throw new Error("Reconnect your MCP account");
        await policy.validate(url);
        await redirect(String(url));
      },
      saveCodeVerifier: async (verifier) => {
        secret.verifier = verifier;
        await save();
      },
      codeVerifier: () => {
        if (!secret.verifier) throw new Error("OAuth flow expired");
        return secret.verifier;
      },
      discoveryState: () => secret.discovery,
      saveDiscoveryState: async (discovery) => {
        secret.discovery = discovery;
        await save();
      },
      invalidateCredentials: async (kind) => {
        if (kind === "tokens" || kind === "all") {
          secret.tokens = undefined;
          secret.tokenExpiresAt = undefined;
        }
        if (kind === "client" || kind === "all") secret.client = undefined;
        if (kind === "verifier" || kind === "all") secret.verifier = undefined;
        if (kind === "discovery" || kind === "all") secret.discovery = undefined;
        await save();
      },
    };
  }
  async function withClient<T>(
    connection: McpConnection,
    actor: string,
    run: (client: Client, secret: AccountSecret) => Promise<T>,
  ): Promise<T> {
    return lock.withLock(`mcp-account:${accountId(connection.id, actor)}`, async () => {
      if (!(await opts.active(actor))) throw new McpAccessError();
      const secret = (await account(connection, actor)) ?? {};
      let token = secret.bearerToken;
      if (connection.auth !== "none" && !(await account(connection, actor)))
        throw new Error("Connect your account before using this MCP connection");
      if (connection.auth === "oauth") {
        if (!secret.tokens || (secret.tokenExpiresAt !== undefined && secret.tokenExpiresAt < Date.now() + 60_000)) {
          if (!secret.tokens?.refresh_token) throw new Error("Reconnect your MCP account");
          const result = await authorize(
            provider(connection, secret, () => saveAccount(connection, actor, secret)),
            { serverUrl: connection.url, fetchFn: policy.fetch },
          );
          if (result !== "AUTHORIZED") throw new Error("Reconnect your MCP account");
        }
        token = secret.tokens?.access_token;
      }
      if (connection.auth === "client-credentials") {
        if (!secret.tokenUrl || !secret.client?.client_secret) throw new Error("Connect client credentials first");
        if (!secret.tokens || (secret.tokenExpiresAt ?? 0) < Date.now() + 60_000) {
          const response = await policy.fetch(secret.tokenUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "client_credentials",
              client_id: secret.client.client_id,
              client_secret: secret.client.client_secret,
              resource: connection.url,
            }),
          });
          if (!response.ok) throw new Error(`MCP token request failed (HTTP ${response.status})`);
          const tokens = (await response.json()) as OAuthTokens;
          if (!tokens.access_token) throw new Error("Token endpoint returned no access token");
          secret.tokens = tokens;
          secret.tokenExpiresAt = Date.now() + (tokens.expires_in ?? 300) * 1000;
          await saveAccount(connection, actor, secret);
        }
        token = secret.tokens.access_token;
      }
      const client = new Client({ name: "qm", version: "1.0.0" });
      const transport = new StreamableHTTPClientTransport(new URL(connection.url), {
        fetch: policy.fetch,
        requestInit: { redirect: "error", ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) },
        reconnectionOptions: {
          maxRetries: 0,
          maxReconnectionDelay: 1000,
          initialReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1,
        },
      });
      try {
        await client.connect(transport);
        return await run(client, secret);
      } catch (failure) {
        if (failure instanceof McpAccessError) throw failure;
        let detail = failure instanceof Error ? failure.message : "MCP request failed";
        for (const value of [
          secret.bearerToken,
          secret.client?.client_secret,
          secret.tokens?.access_token,
          secret.tokens?.refresh_token,
        ])
          if (value) detail = detail.split(value).join("[redacted]");
        opts.audit.record({
          at: Date.now(),
          principalId: actor,
          action: "mcp.transport.failed",
          resource: connection.id,
          scopeLabel: connection.ownerScopeId,
          status: "failed",
          detail: detail.slice(0, 1000),
        });
        if (failure instanceof McpEndpointPolicyError) throw failure;
        throw new Error("MCP request failed. Check the connection, account permissions, and server availability.", {
          cause: failure,
        });
      } finally {
        await client.close();
      }
    });
  }
  async function test(id: string, actor: string) {
    const connection = await requireAccess(id, actor);
    if (connection.blockedByAdmin) throw new McpAccessError("This connection was disabled by an administrator");
    const tools = await withClient(connection, actor, async (client, secret) => {
      const discovered: McpToolDescriptor[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await client.listTools(cursor ? { cursor } : undefined);
        discovered.push(
          ...result.tools.map((tool): McpToolDescriptor => ({
            name: toolName(connection.id, tool.name),
            serverId: id,
            remoteName: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema,
            readOnly: connection.tools.find((known) => known.remoteName === tool.name)?.readOnly ?? false,
          })),
        );
        cursor = result.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error("MCP server returned a repeated discovery cursor");
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if (new Set(discovered.map((tool) => tool.name)).size !== discovered.length)
        throw new Error("MCP server returned colliding tool names");
      secret.tools = discovered;
      if (connection.auth !== "none") await saveAccount(connection, actor, secret);
      return discovered;
    }).catch(async (failure) => {
      await lock.withLock(`mcp-connection:${id}`, async () => {
        const current = await stores.connections.get(id);
        if (current && current.version === connection.version && (await manager(actor, current))) {
          current.lastTest = { at: Date.now(), ok: false };
          await stores.connections.put(id, current);
        }
      });
      throw failure;
    });
    await lock.withLock(`mcp-connection:${id}`, async () => {
      const current = await requireAccess(id, actor);
      if (current.version !== connection.version) throw new McpAccessError();
      if (await manager(actor, current)) {
        current.tools = tools.map((tool) => ({
          ...tool,
          approved: current.tools.find((known) => known.remoteName === tool.remoteName)?.approved ?? false,
        }));
        current.updatedAt = Date.now();
        current.lastTest = { at: Date.now(), ok: true };
        await stores.connections.put(id, current);
      }
      audit("test", current, actor);
    });
    return tools;
  }
  async function publicConnection(connection: McpConnection, actor: string) {
    const rights = await access(connection, actor);
    const mine = await account(connection, actor);
    const canManage = await manager(actor, connection);
    const delegated = await Promise.all(
      rights
        .filter((right) => right.account === "saved" && right.accountOwner)
        .map(async (right) => ({ right, secret: await account(connection, right.accountOwner!) })),
    );
    const visibleTools =
      mine?.tools ??
      (connection.auth === "none" || canManage
        ? connection.tools
        : delegated.flatMap(({ right, secret }) =>
            (secret?.tools ?? []).filter((tool) => right.tools.includes(tool.remoteName)),
          ));
    let accountStatus = connection.auth === "none" || mine ? "Connected" : "Not connected";
    if (mine?.tokens && mine.tokenExpiresAt && mine.tokenExpiresAt < Date.now() && !mine.tokens.refresh_token)
      accountStatus = "Reconnect required";
    const usableSaved = delegated.some(
      ({ secret }) =>
        connection.auth === "none" ||
        secret?.bearerToken ||
        secret?.tokens ||
        (connection.auth === "client-credentials" && secret?.client),
    );
    let status = usableSaved || accountStatus === "Connected" ? "Ready" : accountStatus;
    if (canManage && status === "Ready" && connection.lastTest?.ok === false) status = "Unreachable";
    if (!connection.enabled || connection.blockedByAdmin) status = "Disabled";
    return {
      ...connection,
      status,
      tools: visibleTools.map((tool) => ({
        ...tool,
        readOnly: connection.tools.find((approved) => approved.remoteName === tool.remoteName)?.readOnly ?? false,
        approved: connection.tools.find((approved) => approved.remoteName === tool.remoteName)?.approved ?? false,
      })),
      shares: canManage ? connection.shares : [],
      canManage,
      access: rights,
      accountConnected:
        connection.auth === "none" ||
        !!(mine?.bearerToken || (connection.auth === "client-credentials" && mine?.client) || mine?.tokens),
      accountStatus,
    };
  }
  async function select(connection: McpConnection, context: McpExecutionContext) {
    if (!connection.enabled || connection.blockedByAdmin || !context.audience.length) return [];
    const rights = (await access(connection, context.principalId)).filter(
      (right) => sameScope(right.scopeId, context.scopeId) && (!context.unattended || right.unattended),
    );
    const selected: Array<{ right: McpAccess; owner: string; tools: McpToolDescriptor[] }> = [];
    for (const right of rights) {
      if (
        !(
          await Promise.all(
            context.audience.map((person) =>
              person.type === "internal" ? member(person.id, right.scopeId) : Promise.resolve(false),
            ),
          )
        ).every(Boolean)
      )
        continue;
      const owner = right.account === "saved" ? right.accountOwner : context.principalId;
      if (!owner || !(await opts.active(owner))) continue;
      if (right.account === "saved" && !(await member(owner, connection.ownerScopeId))) continue;
      const secret = await account(connection, owner);
      if (connection.auth !== "none" && !secret) continue;
      const catalog = secret?.tools ?? (connection.auth === "none" ? connection.tools : []);
      const tools = catalog
        .filter((tool) => {
          const approval = connection.tools.find((known) => known.remoteName === tool.remoteName);
          return (
            approval?.approved &&
            right.tools.includes(tool.remoteName) &&
            (approval.readOnly || (right.write && !context.readOnly))
          );
        })
        .map((tool) => ({
          ...tool,
          readOnly: connection.tools.find((known) => known.remoteName === tool.remoteName)!.readOnly,
        }));
      selected.push({ right, owner, tools });
    }
    return selected;
  }
  return {
    clientMetadata,
    policy,
    manager,
    async list(actor: string) {
      const rows = await stores.connections.all();
      const visible = await Promise.all(
        rows.map(async (connection) =>
          (await access(connection, actor)).length ? publicConnection(connection, actor) : null,
        ),
      );
      return visible.filter((row) => row !== null);
    },
    async get(id: string, actor: string) {
      return publicConnection(await requireAccess(id, actor), actor);
    },
    async inventory() {
      return (await stores.connections.all()).map(({ shares, ...connection }) => ({
        ...connection,
        shares: shares.map(({ accountOwner, ...share }) => ({ ...share, accountOwner })),
      }));
    },
    async create(actor: string, input: McpConnectionInput) {
      await validateConnectionUrl(input.url);
      const home = input.ownerScopeId ?? scopeId("personal", actor);
      const connection: McpConnection = {
        id: `mc${randomUUID().replaceAll("-", "")}`,
        name: input.name,
        url: input.url,
        auth: input.auth,
        ownerScopeId: home,
        createdBy: actor,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: 1,
        enabled: false,
        tools: [],
        unattended: false,
        shares: [],
      };
      if (!(await manager(actor, connection)))
        throw new McpAccessError("Only the personal owner or project owner can add a connection here");
      await stores.connections.put(connection.id, connection);
      audit("create", connection, actor);
      return publicConnection(connection, actor);
    },
    async update(id: string, actor: string, input: Partial<McpConnectionInput>) {
      return lock.withLock(`mcp-connection:${id}`, async () => {
        const connection = await requireAccess(id, actor, true);
        if (input.url !== undefined) await validateConnectionUrl(input.url);
        const changedEndpoint =
          (input.url !== undefined && input.url !== connection.url) ||
          (input.auth !== undefined && input.auth !== connection.auth);
        if (changedEndpoint) {
          connection.version++;
          connection.enabled = false;
          connection.tools = [];
          connection.shares = connection.shares.map((share) => ({ ...share, account: "own", accountOwner: undefined }));
          connection.homeAccountOwner = undefined;
        }
        if (!changedEndpoint && input.homeAccountOwner) {
          if (!samePerson(input.homeAccountOwner, actor) || !(await account(connection, actor)))
            throw new McpAccessError("Only your own connected account can be delegated");
          connection.homeAccountOwner = actor;
        }
        if (input.homeAccountOwner === null) connection.homeAccountOwner = undefined;
        if (input.name !== undefined) connection.name = input.name;
        if (input.url !== undefined) connection.url = input.url;
        if (input.auth !== undefined) connection.auth = input.auth;
        if (input.unattended !== undefined) connection.unattended = input.unattended;
        if (input.tools)
          for (const approval of input.tools) {
            const tool = connection.tools.find((known) => known.remoteName === approval.name);
            if (!tool) throw new Error("Tool not found; test the connection first");
            tool.approved = approval.approved;
            tool.readOnly = approval.readOnly;
          }
        if (!changedEndpoint && input.enabled === true && connection.blockedByAdmin)
          throw new McpAccessError("This connection was disabled by an administrator");
        if (!changedEndpoint && input.enabled === true && !connection.tools.some((tool) => tool.approved))
          throw new Error("Test discovery and approve at least one tool before enabling");
        if (!changedEndpoint && input.enabled !== undefined) connection.enabled = input.enabled;
        connection.updatedAt = Date.now();
        await stores.connections.put(id, connection);
        audit("update", connection, actor);
        return publicConnection(connection, actor);
      });
    },
    async disable(id: string, actor: string) {
      return lock.withLock(`mcp-connection:${id}`, async () => {
        const connection = await stores.connections.get(id);
        if (!connection) throw new McpAccessError();
        connection.enabled = false;
        connection.blockedByAdmin = true;
        await stores.connections.put(id, connection);
        audit("admin-disable", connection, actor);
      });
    },
    async unblock(id: string, actor: string) {
      return lock.withLock(`mcp-connection:${id}`, async () => {
        const connection = await stores.connections.get(id);
        if (!connection) throw new McpAccessError();
        connection.blockedByAdmin = false;
        await stores.connections.put(id, connection);
        audit("admin-unblock", connection, actor);
      });
    },
    async delete(id: string, actor: string) {
      return lock.withLock(`mcp-connection:${id}`, async () => {
        const connection = await requireAccess(id, actor, true);
        await stores.connections.delete(id);
        for (const [key, row] of await stores.accounts.entries())
          if (row.connectionId === id) await stores.accounts.delete(key);
        for (const [key, row] of await stores.flows.entries())
          if (row.connectionId === id) await stores.flows.delete(key);
        for (const grant of await acl.grantsFor(connection.ownerScopeId, ref(id)))
          await acl.revoke(connection.ownerScopeId, ref(id), grant.granteeScopeId, actor);
        audit("delete", connection, actor);
      });
    },
    test,
    async connect(id: string, actor: string, input: McpAccountInput) {
      return lock.withLock(`mcp-connection:${id}`, async () =>
        lock.withLock(`mcp-account:${accountId(id, actor)}`, async () => {
          const connection = await requireAccess(id, actor);
          if (connection.blockedByAdmin) throw new McpAccessError("This connection was disabled by an administrator");
          if (connection.auth === "none") return { connected: true };
          const secret: AccountSecret = {};
          if (connection.auth === "bearer") {
            if (!input.bearerToken) throw new Error("Bearer token required");
            secret.bearerToken = input.bearerToken;
          }
          if (connection.auth === "client-credentials" || connection.auth === "oauth") {
            if (connection.auth === "oauth" && input.clientId && !input.issuer)
              throw new Error("Authorization server issuer required for a registered OAuth client");
            if (input.issuer) await policy.validate(input.issuer);
            if (input.clientId)
              secret.client = {
                client_id: input.clientId,
                ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
                ...(input.issuer ? { issuer: input.issuer } : {}),
              };
            if (connection.auth === "client-credentials") {
              if (!secret.client || !input.clientSecret || !input.tokenUrl)
                throw new Error("Client ID, client secret and token URL required");
              await policy.validate(input.tokenUrl);
              secret.tokenUrl = input.tokenUrl;
            }
          }
          if (connection.homeAccountOwner && samePerson(connection.homeAccountOwner, actor))
            connection.homeAccountOwner = undefined;
          connection.shares = connection.shares.filter((share) => !samePerson(share.accountOwner, actor));
          await stores.connections.put(id, connection);
          if (connection.auth !== "oauth") {
            await saveAccount(connection, actor, secret);
            audit("connect", connection, actor);
            return { connected: true };
          }
          const state = randomUUID();
          const save = async () =>
            stores.flows.put(state, {
              connectionId: id,
              principalId: actor,
              version: connection.version,
              secretEnc: encode(secret),
              issuedAt: Date.now(),
            });
          await save();
          let authorizationUrl = "";
          const result = await authorize(
            provider(connection, secret, save, state, async (url) => {
              authorizationUrl = url;
            }),
            { serverUrl: connection.url, fetchFn: policy.fetch },
          );
          if (result === "AUTHORIZED") {
            await saveAccount(connection, actor, secret);
            await stores.flows.delete(state);
          }
          return authorizationUrl ? { authorizationUrl } : { connected: true };
        }),
      );
    },
    async callback(state: string, code: string) {
      const flow = await stores.flows.take(state);
      if (!flow || Date.now() - flow.issuedAt > 10 * 60_000 || !code)
        throw new Error("OAuth flow expired or already used");
      return lock.withLock(`mcp-connection:${flow.connectionId}`, async () =>
        lock.withLock(`mcp-account:${accountId(flow.connectionId, flow.principalId)}`, async () => {
          const connection = await requireAccess(flow.connectionId, flow.principalId);
          if (connection.blockedByAdmin) throw new McpAccessError("This connection was disabled by an administrator");
          if (connection.version !== flow.version) throw new Error("MCP configuration changed; reconnect");
          const secret = decode(flow.secretEnc);
          const result = await authorize(
            provider(connection, secret, async () => {}, state),
            { serverUrl: connection.url, authorizationCode: code, fetchFn: policy.fetch },
          );
          if (result !== "AUTHORIZED") throw new Error("MCP authorization failed");
          if (connection.homeAccountOwner && samePerson(connection.homeAccountOwner, flow.principalId))
            connection.homeAccountOwner = undefined;
          connection.shares = connection.shares.filter((share) => !samePerson(share.accountOwner, flow.principalId));
          await stores.connections.put(connection.id, connection);
          secret.verifier = undefined;
          await saveAccount(connection, flow.principalId, secret);
          audit("connect", connection, flow.principalId);
          return connection.id;
        }),
      );
    },
    async disconnect(id: string, actor: string) {
      return lock.withLock(`mcp-connection:${id}`, async () => {
        const connection = await stores.connections.get(id);
        if (
          !connection ||
          !(await opts.active(actor)) ||
          (!(await stores.accounts.get(accountId(id, actor))) && !(await access(connection, actor)).length)
        )
          throw new McpAccessError();
        await lock.withLock(`mcp-account:${accountId(id, actor)}`, () => stores.accounts.delete(accountId(id, actor)));
        if (connection.homeAccountOwner === actor) connection.homeAccountOwner = undefined;
        connection.shares = connection.shares.filter((share) => share.accountOwner !== actor);
        await stores.connections.put(id, connection);
        audit("disconnect", connection, actor);
      });
    },
    async share(id: string, actor: string, share: McpAccess) {
      return lock.withLock(`mcp-connection:${id}`, async () => {
        const connection = await requireAccess(id, actor, true);
        const parsed = parseScopeId(share.scopeId);
        if (parsed.kind === "personal") {
          if (!(await opts.active(parsed.ref)) || (opts.recipient && !(await opts.recipient(parsed.ref))))
            throw new Error("Recipient must be an active internal directory user");
        } else if (parsed.kind !== "group" || !(await member(actor, share.scopeId)))
          throw new McpAccessError("Share only with a project you belong to or an internal user");
        if (share.tools.some((name) => !connection.tools.some((tool) => tool.remoteName === name && tool.approved)))
          throw new Error("Only approved tools can be shared");
        if (share.account === "saved") {
          if (!(await account(connection, actor))) throw new Error("Connect your own account before delegating it");
          share.accountOwner = actor;
        } else share.accountOwner = undefined;
        connection.shares = [...connection.shares.filter((known) => known.scopeId !== share.scopeId), share];
        await acl.grant({
          ownerScopeId: connection.ownerScopeId,
          ref: ref(id),
          granteeScopeId: share.scopeId,
          permission: "read",
          grantedBy: actor,
        });
        await stores.connections.put(id, connection);
        audit("share", connection, actor);
        return publicConnection(connection, actor);
      });
    },
    async revoke(id: string, actor: string, target: string) {
      return lock.withLock(`mcp-connection:${id}`, async () => {
        const connection = await requireAccess(id, actor, true);
        await acl.revoke(connection.ownerScopeId, ref(id), target, actor);
        connection.shares = connection.shares.filter((share) => share.scopeId !== target);
        await stores.connections.put(id, connection);
        audit("revoke", connection, actor);
      });
    },
    async forTurn(context: McpExecutionContext): Promise<Pick<McpToolService, "toolDefs" | "call">> {
      const rows = await stores.connections.all();
      const selected = await Promise.all(rows.map((connection) => select(connection, context)));
      const snapshot = selected.flatMap((items) => items.flatMap((item) => item.tools));
      const seen = new Set<string>();
      const unique = snapshot.filter((tool) => (seen.has(tool.name) ? false : (seen.add(tool.name), true)));
      return {
        toolDefs: () => unique,
        async call(name, args) {
          const descriptor = snapshot.find((tool) => tool.name === name);
          if (!descriptor) throw new McpAccessError();
          const connection = await stores.connections.get(descriptor.serverId);
          if (!connection) throw new McpAccessError();
          const rights = await select(connection, context);
          const chosen = rights.find((item) =>
            item.tools.some((tool) => tool.name === name && tool.remoteName === descriptor.remoteName),
          );
          if (!chosen) throw new McpAccessError();
          try {
            return await withClient(connection, chosen.owner, async (client) => {
              const current = await stores.connections.get(connection.id);
              if (
                !current ||
                current.version !== connection.version ||
                !(await select(current, context)).some(
                  (item) =>
                    item.owner === chosen.owner &&
                    item.tools.some((tool) => tool.name === name && tool.remoteName === descriptor.remoteName),
                )
              )
                throw new McpAccessError();
              const result = await client.callTool({ name: descriptor.remoteName, arguments: args });
              if (result.isError) throw new Error("Remote MCP tool returned an error");
              audit(`call.${descriptor.remoteName}`, connection, context.principalId, "ok", chosen.owner);
              return (
                mcpResultText(result as import("./mcp-client.ts").McpToolResult) ||
                JSON.stringify(result.structuredContent ?? "")
              ).slice(0, 60_000);
            });
          } catch (error) {
            audit(`call.${descriptor.remoteName}`, connection, context.principalId, "failed", chosen.owner);
            throw error;
          }
        },
      };
    },
    async projectScopes(actor: string) {
      return (await projects.listForMember(actor)).map((project) => ({
        id: project.id,
        name: project.name,
        scopeId: projectScopeId(project.id),
        canManage: samePerson(project.ownerId, actor),
      }));
    },
  };
}
export type McpConnectionService = ReturnType<typeof createMcpConnectionService>;
