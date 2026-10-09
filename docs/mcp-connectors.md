# MCP connector credentials

Administrators register HTTP MCP servers through `PUT /v1/admin/mcp-servers/:id`.
Registration controls the outbound destination and the tools available to agents.

`credentialScope` selects the identity used for `tools/call`:

- `shared` (the default for existing and new registrations): all callers use the
  configured `auth`, `bearerToken`, or `clientId` and `clientSecret`.
- `per-user`: each call uses the initiating actor's bearer token from the encrypted
  connector keychain, under `credentialHost` in the selected `credentialAccountType`
  slot (`default`, `personal`, or `company`; defaults to `default`). The
  runtime supplies the actor; tool arguments cannot select another user.

For example:

```json
{
  "name": "Customer tools",
  "url": "https://tools.example.com/mcp",
  "auth": "none",
  "credentialScope": "per-user",
  "credentialHost": "accounts.example.com",
  "readOnly": false,
  "enabled": true
}
```

Per-user mode requires persistent keychain encryption (`CONNECTOR_SECRET_KEY`).
Connect the user's account using an existing QM OAuth connector, or have a trusted
integration save its token through the source-authenticated
`POST /v1/connectors/token` endpoint with `host`, `principalId`, `accessToken`, and
optional `expiresAt` (Unix milliseconds). Supported OAuth providers can also store
and refresh a `refreshToken`. This change does not add OAuth provider discovery or
an interactive MCP login flow. An unsupported provider must manage token renewal
in its integration; do not store a refresh token that QM cannot refresh.

Missing, expired, revoked, or unrefreshable user credentials fail the call with a
connection-required message. Per-user MCP calls do not use operator environment
tokens, organization credentials, another user's account, or the shared discovery
credential as fallback. Tokens are resolved again for every call rather than
cached across users. Triggered work uses its existing initiating actor identity.

Tool discovery (`tools/list`, including registration probes) remains connector-wide
and uses the configured `auth`. In per-user mode those credentials are only for
catalog discovery. The server must expose a common, non-sensitive catalog and
check each caller's permissions when executing a tool. A public catalog can use
`auth: "none"`; a private catalog can use a dedicated shared discovery credential.
Do not put user-specific data into names, descriptions, or schemas.

`credentialHost` explicitly authorizes sending that connector's user token to the
registered server. Only register a trusted service permitted to receive those
tokens. Per-user endpoints require HTTPS, except on loopback for local development.
HTTP redirects are rejected for every MCP authentication mode. Updating an endpoint
or credential host is an administrative trust decision. Tool call auditing records
the initiating actor as before; authentication does not expand the audience allowed
to receive the result.

## Browse → MCP

Internal users manage remote HTTP MCP connections from the left sidebar's Browse → MCP page.
The inventory includes personal connections, direct shares, and connections in projects the user currently belongs to.
Project connections are usable only in that project's conversations, including its linked Slack channel.

To add a connection:

1. Choose Add MCP, enter its name and exact server URL, and select a personal home or a project you own.
2. Choose no authentication, bearer token, OAuth, or client credentials. The connection starts disabled.
3. Connect your account. OAuth discovers the authorization server and supports metadata-document client IDs,
   dynamic registration, or a manually registered client ID with its issuer. Client credentials require an explicit token endpoint.
4. Test discovery. Newly discovered tools start disabled. Open Manage tool permissions to approve tools and classify which ones are read-only.
   The dialog searches tool names and descriptions and shows 20 tools per page. Select all, Deselect all,
   Mark read-only, and Allow writes apply to every search match across all pages; without a search they apply to all tools.
   Save permissions persists the changes; Cancel discards them.
5. Enable the connection. Unattended use is off until explicitly enabled.

CONNECTOR_SECRET_KEY is required for authenticated connections and their encrypted account catalogs.
Credentials stay in core and are never returned in API read responses or injected into a shared sandbox.
OAuth uses the fixed public callback `/api/mcp-oauth/callback`; configure PUBLIC_WEB_URL to the reachable web surface.
The public `/api/mcp-oauth/client-metadata` document advertises that callback for servers supporting metadata-document client IDs.

Owners can share with a named internal teammate or a project they belong to. Each share selects tools,
read/write access, unattended permission, and either the recipient's own account or the owner's saved account.
Choose permitted tools opens the same searchable, paginated picker. Apply selection updates the share draft;
Share connection saves it. Only approved tools can be shared. Connections you can manage have an Actions menu
in the inventory with Manage and Delete. Deletion requires confirmation and removes shared access.
Saved-account sharing explicitly authorizes recipients to execute as the credential owner without viewing its secrets.
Recipients cannot edit, delete, or re-share the connection. Project owners manage project-owned connections.
Changing the server URL or authentication method requires reconnecting accounts and approving tools again.
Replacing or disconnecting an account removes its saved-account delegations; reconnecting never restores those grants automatically.

Tool catalogs and execution are resolved for the initiating actor and the conversation's scope and audience.
Every call rechecks current membership, sharing, selected tools, unattended permission, and account authorization.
Personal access does not carry into a project, and project membership does not carry access into personal chats.
Revocation stops subsequent calls, including calls from an old tool catalog; already-dispatched remote operations cannot be undone.

## Admin → MCP

Admins can inspect scoped connections, disable them, and toggle Allow HTTP and private MCP endpoints.
An administrative disable blocks owner re-enablement until an administrator unblocks the connection.
HTTP and private MCP endpoints are allowed by default, including localhost, private IP addresses, and internal DNS names.
Admins can disable them with the deployment-wide toggle in Admin → MCP; then only public HTTPS endpoints are allowed.
Localhost refers to the QM core container. Existing endpoint exceptions are replaced by the enabled default.
Turning the toggle off blocks subsequent requests without deleting connections, credentials, or shares. The same network policy applies to MCP discovery and calls,
OAuth metadata and registration, and token exchange/refresh. DNS is checked and pinned on each request;
redirects are rejected and responses are bounded.

Existing admin-registered servers remain labeled Legacy instance-wide, retaining their tool names and audience.
Legacy bearer/client secrets migrate idempotently to encrypted records when persistent connector encryption is configured.
To narrow a legacy audience, add a scoped connection, verify its intended user/project access, and disable the legacy entry.

The scoped API is `/v1/mcp-connections` with list/create and `/:id` read/update/delete operations.
`/:id/test` tests authenticated discovery, `/:id/tools` reads the current catalog, `/:id/account` connects/disconnects
an account, and `/:id/shares` creates or revokes scoped use-only shares. User requests bind `principalId` to the verified
portal identity or live capability actor. The web surface injects the signed-in identity and signs each core request.
Admin endpoints are `/v1/admin/mcp-connections`, `/:id/disable`, `/:id/unblock`, and `/v1/admin/mcp-policy`.
