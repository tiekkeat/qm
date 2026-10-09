import "./mcp.css";
import { html, nothing, render } from "lit";
import { until } from "lit/directives/until.js";
import { api } from "./core-bridge";
import { appState, switchView } from "./shell";
import { deepLinkPath, UI_BASE } from "./deep-link";
import { openMcpToolsDialog, type McpSelectableTool } from "./mcp-tools-dialog";
import { focusDialogCancel, restoreDialogFocus, trapDialogFocus } from "./dialog-focus";
import { errMessage } from "../../chassis/src/errors";

interface Tool {
  name: string;
  remoteName: string;
  description: string;
  approved: boolean;
  readOnly: boolean;
}
interface Access {
  scopeId: string;
  tools: string[];
  write: boolean;
  unattended: boolean;
  account: "own" | "saved";
  accountOwner?: string;
}
interface Connection {
  id: string;
  name: string;
  url: string;
  auth: "none" | "bearer" | "oauth" | "client-credentials";
  ownerScopeId: string;
  createdBy: string;
  enabled: boolean;
  blockedByAdmin?: boolean;
  unattended: boolean;
  homeAccountOwner?: string;
  tools: Tool[];
  shares: Access[];
  access: Access[];
  canManage: boolean;
  accountConnected: boolean;
  accountStatus: string;
  status: string;
}
interface Project {
  id: string;
  name: string;
  scopeId: string;
  canManage: boolean;
}
interface Inventory {
  connections: Connection[];
  projects: Project[];
  legacy: Array<{ id: string; name: string; url: string; enabled: boolean }>;
}

let inventory: Inventory = { connections: [], projects: [], legacy: [] };
let host: HTMLElement | null = null;
let selected: string | null = null;
let filter = "all";
let search = "";
let projectFilter = "";
let notice = "";
let error = false;
let busy = false;
let adding = false;
let refreshSequence = 0;
let shareDraft: { id: string; tools: Set<string> } | null = null;

export function openProjectMcp(scope: string): void {
  selected = null;
  projectFilter = scope;
  filter = "projects";
  switchView("mcp");
}
const projectCatalog = new Map<string, { expires: number; result: Promise<Inventory> }>();
export function projectMcpSection(scope: string) {
  const key = `${appState.me?.user}:${scope}`;
  let cached = projectCatalog.get(key);
  if (!cached || cached.expires < Date.now()) {
    cached = { expires: Date.now() + 15_000, result: api<Inventory>("/api/mcp-connections") };
    projectCatalog.set(key, cached);
  }
  const content = cached.result
    .then((data) => {
      const rows = data.connections.filter((connection) => connection.access.some((right) => right.scopeId === scope));
      return html`${rows.length ? rows.map((connection) => html`<p><a href=${deepLinkPath(UI_BASE, "mcp", null, null, connection.id)}>${connection.name}</a> · ${connection.enabled ? "Enabled" : "Disabled"}</p>`) : html`<p class="context-inline-empty">No MCP connections shared with this project.</p>`}`;
    })
    .catch(() => html`<p role="status">MCP connections could not be loaded.</p>`);
  return html`<section class="context-panel">
    <div class="context-panel-heading">
      <h2 class="context-panel-title">MCP</h2>
      <button type="button" @click=${() => openProjectMcp(scope)}>Browse connections</button>
    </div>
    ${until(content, html`<p>Loading MCP connections…</p>`)}
  </section>`;
}

export function openMcpById(id: string | null): void {
  selected = id;
  adding = false;
  if (id === null) {
    filter = "all";
    projectFilter = "";
    search = "";
    notice = "";
  }
}
export function routeMcpHistory(id: string | null): void {
  selected = id;
  adding = false;
  draw();
}
function navigate(id: string | null) {
  selected = id;
  adding = false;
  history.pushState(null, "", deepLinkPath(UI_BASE, "mcp", null, null, id));
  draw();
}
export async function renderMcp(): Promise<void> {
  const sequence = ++refreshSequence;
  if (appState.currentView !== "mcp" || !appState.mainEl) return;
  if (!host || host.parentElement !== appState.mainEl) {
    host = document.createElement("div");
    host.className = "mcp-page";
    appState.mainEl.replaceChildren(host);
  }
  busy = true;
  draw();
  try {
    const result = await api<Inventory>("/api/mcp-connections");
    if (sequence !== refreshSequence) return;
    inventory = result;
    if (selected && inventory.connections.some((connection) => connection.id === selected)) {
      const detail = await api<{ connection: Connection }>(`/api/mcp-connections/${encodeURIComponent(selected)}`);
      if (sequence !== refreshSequence) return;
      inventory.connections = inventory.connections.map((row) => (row.id === selected ? detail.connection : row));
      history.replaceState(null, "", deepLinkPath(UI_BASE, "mcp", null, null, selected));
    } else if (selected) {
      notice = "Connection unavailable or access removed.";
      error = true;
    }
  } catch (failure) {
    if (sequence === refreshSequence) {
      notice = errMessage(failure);
      error = true;
    }
  } finally {
    if (sequence === refreshSequence) {
      busy = false;
      draw();
    }
  }
}
async function action(run: () => Promise<unknown>, message: string) {
  if (busy) return;
  busy = true;
  notice = "";
  draw();
  try {
    await run();
    notice = message;
    error = false;
  } catch (failure) {
    notice = errMessage(failure);
    error = true;
  } finally {
    busy = false;
    await renderMcp();
  }
}
function fields(event: Event): FormData {
  event.preventDefault();
  return new FormData(event.currentTarget as HTMLFormElement);
}
function value(data: FormData, name: string): string {
  return String(data.get(name) ?? "").trim();
}
function projectName(scope: string) {
  const project = inventory.projects.find((row) => row.scopeId === scope);
  if (project) return project.name;
  if (scope.startsWith("personal:"))
    return scope.slice("personal:".length) === appState.me?.user ? "Personal (you)" : scope.slice("personal:".length);
  return scope;
}
function openProject(scope: string) {
  location.href = deepLinkPath(UI_BASE, "contexts", null, scope);
}
const button = (label: string, click: () => void, danger = false) =>
  html`<button type="button" class=${danger ? "danger" : ""} ?disabled=${busy} @click=${click}>${label}</button>`;

function addForm() {
  return html`<section class="mcp-card">
    <h2>Add MCP</h2>
    <form
      @submit=${(event: Event) => {
        const data = fields(event);
        void action(async () => {
          const result = await api<{ connection: Connection }>("/api/mcp-connections", {
            method: "POST",
            body: JSON.stringify({
              name: value(data, "name"),
              url: value(data, "url"),
              auth: value(data, "auth"),
              ...(value(data, "home") ? { ownerScopeId: value(data, "home") } : {}),
            }),
          });
          navigate(result.connection.id);
        }, "Connection saved as a draft. Connect your account and test discovery.");
      }}
    >
      <label>Name<input name="name" required maxlength="80" placeholder="Customer tools" /></label>
      <label>Server URL<input name="url" type="url" required placeholder="https://tools.example.com/mcp" /></label>
      <label
        >Home<select name="home" aria-label="Home">
          <option value="">Personal</option>
          ${inventory.projects.filter((project) => project.canManage).map((project) => html`<option value=${project.scopeId}>${project.name}</option>`)}
        </select></label
      >
      <label
        >Authentication<select name="auth" aria-label="Authentication">
          <option value="oauth">OAuth</option>
          <option value="bearer">Bearer token</option>
          <option value="client-credentials">Client credentials</option>
          <option value="none">No authentication</option>
        </select></label
      >
      <p class="mcp-hint">
        HTTP and private endpoints work when enabled in Admin → MCP. Localhost refers to the QM core container.
      </p>
      <div class="mcp-actions">
        <button type="submit" ?disabled=${busy}>Save draft</button>${button("Cancel", () => {
          adding = false;
          draw();
        })}
      </div>
    </form>
  </section>`;
}
function accountForm(connection: Connection) {
  if (connection.auth === "none") return nothing;
  return html`<section class="mcp-card">
    <h2>Your account</h2>
    <p>${connection.accountStatus}</p>
    <form
      @submit=${(event: Event) => {
        const data = fields(event);
        void action(async () => {
          const credentials = Object.fromEntries(
            [...data.entries()].map(([key, entry]) => [key, String(entry)]).filter(([, entry]) => entry),
          );
          const result = await api<{ authorizationUrl?: string }>(`/api/mcp-connections/${connection.id}/account`, {
            method: "POST",
            body: JSON.stringify(credentials),
          });
          (event.target as HTMLFormElement).reset();
          if (result.authorizationUrl) location.assign(result.authorizationUrl);
        }, "Account connected. Test discovery to load your tools.");
      }}
    >
      ${
        connection.auth === "bearer"
          ? html`<label>Bearer token<input name="bearerToken" type="password" required autocomplete="off" /></label>`
          : html`
              <label
                >Client ID ${connection.auth === "oauth" ? "(optional for automatic registration)" : ""}<input
                  name="clientId"
                  ?required=${connection.auth === "client-credentials"}
                  autocomplete="off"
              /></label>
              <label
                >Client secret<input
                  name="clientSecret"
                  type="password"
                  ?required=${connection.auth === "client-credentials"}
                  autocomplete="off"
              /></label>
              ${connection.auth === "oauth" ? html`<label>Authorization server issuer (for a registered client)<input name="issuer" type="url" /></label>` : html`<label>Token endpoint<input name="tokenUrl" type="url" required /></label>`}
            `
      }
      <div class="mcp-actions">
        <button type="submit" ?disabled=${busy}>
          ${connection.auth === "oauth" ? "Connect with OAuth" : "Save account"}
        </button>
        ${connection.accountConnected ? button("Disconnect", () => void action(() => api(`/api/mcp-connections/${connection.id}/account`, { method: "DELETE" }), "Account disconnected. Delegated calls can no longer use it.")) : nothing}
      </div>
    </form>
  </section>`;
}
function reconcileToolDraft(draft: McpSelectableTool[], catalog: Tool[], sharing: boolean): void {
  const previous = new Map(draft.map((tool) => [tool.remoteName, tool]));
  const current = catalog
    .filter((tool) => !sharing || tool.approved)
    .map((tool) => ({
      ...tool,
      approved: previous.get(tool.remoteName)?.approved ?? (!sharing && tool.approved),
      readOnly: sharing ? tool.readOnly : (previous.get(tool.remoteName)?.readOnly ?? tool.readOnly),
    }));
  draft.splice(0, draft.length, ...current);
}
function toolsForm(connection: Connection) {
  return html`<section class="mcp-card">
    <h2>Tools</h2>
    <p class="mcp-hint">New tools start disabled. Mark a tool read-only only after checking its behavior.</p>
    <div class="mcp-actions">
      ${button("Test connection and discover tools", () => void action(() => api(`/api/mcp-connections/${connection.id}/test`, { method: "POST", body: "{}" }), "Connection test passed. Tools refreshed."))}
      ${
        connection.tools.length
          ? button(
              `${connection.canManage ? "Manage tool permissions" : "View tools"} (${connection.tools.filter((tool) => tool.approved).length}/${connection.tools.length})`,
              () =>
                openMcpToolsDialog({
                  tools: connection.tools,
                  mode: connection.canManage ? "permissions" : "view",
                  onSave: async (tools) => {
                    try {
                      await api(`/api/mcp-connections/${connection.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({
                          tools: tools.map((tool) => ({
                            name: tool.remoteName,
                            approved: tool.approved,
                            readOnly: tool.readOnly,
                          })),
                        }),
                      });
                    } catch (failure) {
                      await renderMcp();
                      const current = inventory.connections.find((row) => row.id === connection.id);
                      if (current) reconcileToolDraft(tools, current.tools, false);
                      throw failure;
                    }
                    notice = "Tool permissions saved.";
                    error = false;
                    await renderMcp();
                  },
                }),
            )
          : nothing
      }
    </div>
    ${connection.tools.length ? html`<p class="mcp-hint">${connection.tools.filter((tool) => tool.approved).length} enabled · ${connection.tools.length} discovered tools</p>` : html`<p>No tools discovered for your account. Connect and test this server.</p>`}
  </section>`;
}
function shareSelection(connection: Connection): Set<string> {
  return shareDraft?.id === connection.id
    ? shareDraft.tools
    : new Set(connection.tools.filter((tool) => tool.approved && tool.readOnly).map((tool) => tool.remoteName));
}
function shareForm(connection: Connection) {
  if (!connection.canManage) return nothing;
  const selectedTools = shareSelection(connection);
  const approved = connection.tools.filter((tool) => tool.approved);
  return html`<section class="mcp-card">
    <h2>Share</h2>
    <form
      @submit=${(event: Event) => {
        const data = fields(event);
        const project = value(data, "project");
        const recipient = value(data, "recipient");
        void action(async () => {
          let scope = project;
          if (!scope) {
            const result = await api<{ matches: Array<{ principalId: string; type: string }> }>(
              `/api/directory/resolve?q=${encodeURIComponent(recipient)}`,
            );
            if (result.matches.length !== 1 || result.matches[0]!.type !== "internal")
              throw new Error("Choose an unambiguous teammate name or principal ID.");
            scope = `personal:${result.matches[0]!.principalId}`;
          }
          await api(`/api/mcp-connections/${connection.id}/shares`, {
            method: "POST",
            body: JSON.stringify({
              scopeId: scope,
              tools: [...selectedTools],
              write: data.has("write"),
              unattended: data.has("unattended"),
              account: value(data, "account"),
            }),
          });
          shareDraft = null;
        }, "Connection shared.");
      }}
    >
      <label
        >Project<select name="project" aria-label="Project">
          <option value="">Named user</option>
          ${inventory.projects.map((project) => html`<option value=${project.scopeId}>${project.name}</option>`)}
        </select></label
      >
      <label>Teammate name or principal ID (for named user)<input name="recipient" /></label>
      <label
        >Account mode<select name="account" aria-label="Account mode">
          <option value="own">Use your own account</option>
          <option value="saved" ?disabled=${connection.auth === "none"}>Use my saved account</option>
        </select></label
      >
      <p class="mcp-hint">
        Saved-account sharing authorizes recipients to act as you. They cannot view your credentials.
      </p>
      <div>
        <p>Permitted tools · ${selectedTools.size} selected</p>
        ${button(`Choose permitted tools (${selectedTools.size}/${approved.length})`, () =>
          openMcpToolsDialog({
            mode: "share",
            tools: approved.map((tool) => ({ ...tool, approved: selectedTools.has(tool.remoteName) })),
            onSave: async (tools) => {
              const { connection: current } = await api<{ connection: Connection }>(
                `/api/mcp-connections/${connection.id}`,
              );
              const chosen = tools.filter((tool) => tool.approved).map((tool) => tool.remoteName);
              if (
                !current.canManage ||
                chosen.some((name) => !current.tools.some((tool) => tool.remoteName === name && tool.approved))
              ) {
                await renderMcp();
                reconcileToolDraft(tools, current.tools, true);
                throw new Error("Available tools or access changed. Review the current catalog before applying.");
              }
              shareDraft = { id: connection.id, tools: new Set(chosen) };
              draw();
            },
          }),
        )}
      </div>
      <label class="mcp-check"><input type="checkbox" name="write" />Allow write tools</label>
      <label class="mcp-check"><input type="checkbox" name="unattended" />Allow scheduled and unattended use</label>
      <button type="submit" ?disabled=${busy}>Share connection</button>
    </form>
    ${connection.shares.map(
      (share) =>
        html`<div class="mcp-share">
          <p>
            <strong>${projectName(share.scopeId)}</strong> ·
            ${share.account === "saved" ? `Saved account: ${share.accountOwner}` : "Each user's own account"} ·
            ${share.write ? "Read/write" : "Read-only"} · ${share.unattended ? "Unattended allowed" : "Live use only"}
          </p>
          ${button("Revoke", () => void action(() => api(`/api/mcp-connections/${connection.id}/shares?scopeId=${encodeURIComponent(share.scopeId)}`, { method: "DELETE" }), "Sharing revoked."))}
        </div>`,
    )}
  </section>`;
}
function detail(connection: Connection) {
  return html`${button("← All MCP connections", () => navigate(null))}
    <h1>${connection.name}</h1>
    <p class="mcp-hint">${connection.url} · ${projectName(connection.ownerScopeId)}</p>
    <section class="mcp-card">
      <h2>Access</h2>
      <p>
        ${connection.blockedByAdmin ? "Disabled by an administrator" : nothing}<span
          >${connection.enabled ? "Enabled" : "Disabled"}</span
        >
      </p>
      ${connection.access.map(
        (right) =>
          html`<p>
              ${projectName(right.scopeId)} ·
              ${right.account === "saved" ? `Uses saved account: ${right.accountOwner}` : "Uses your own account"} ·
              ${right.write ? "Read/write" : "Read-only"} · ${right.tools.length} permitted tools
            </p>
            ${right.scopeId.startsWith("group:") ? button("Open project", () => openProject(right.scopeId)) : nothing}`,
      )}
      ${
        connection.canManage
          ? html`<form
              @submit=${(event: Event) => {
                const data = fields(event);
                void action(
                  () =>
                    api(`/api/mcp-connections/${connection.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({
                        name: value(data, "name"),
                        url: value(data, "url"),
                        enabled: data.has("enabled"),
                        unattended: data.has("unattended"),
                        ...(connection.ownerScopeId.startsWith("group:")
                          ? { homeAccountOwner: data.has("saved") ? appState.me!.user : null }
                          : {}),
                      }),
                    }),
                  "Connection settings saved.",
                );
              }}
            >
              <label>Name<input name="name" .value=${connection.name} required maxlength="80" /></label
              ><label>Server URL<input name="url" type="url" .value=${connection.url} required /></label>
              <label
                >Authentication<select name="auth" aria-label="Authentication" .value=${connection.auth}>
                  <option value="none">No authentication</option>
                  <option value="bearer">Bearer token</option>
                  <option value="client-credentials">Client credentials</option>
                  <option value="oauth">OAuth</option>
                </select></label
              >
              <label class="mcp-check"
                ><input
                  name="enabled"
                  type="checkbox"
                  ?disabled=${connection.blockedByAdmin}
                  .checked=${connection.enabled}
                />Enable connection</label
              >
              <label class="mcp-check"
                ><input name="unattended" type="checkbox" .checked=${connection.unattended} />Allow unattended use in
                home context</label
              >
              ${connection.ownerScopeId.startsWith("group:") ? html`<label class="mcp-check"><input name="saved" type="checkbox" .checked=${connection.homeAccountOwner === appState.me?.user} />Authorize the project to use my saved account</label>` : nothing}
              <div class="mcp-actions">
                <button type="submit" ?disabled=${busy}>Save settings</button>${button(
                  "Delete",
                  () => deleteConnection(connection),
                  true,
                )}
              </div>
            </form>`
          : nothing
      }
    </section>
    ${accountForm(connection)}${toolsForm(connection)}${shareForm(connection)}`;
}
function deleteConnection(connection: Connection): void {
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "mcp-dialog mcp-delete-dialog";
  dialog.setAttribute("aria-labelledby", "mcp-delete-title");
  document.body.append(dialog);
  let saving = false;
  let failure = "";
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    render(nothing, dialog);
    dialog.remove();
    restoreDialogFocus(opener, () => host?.querySelector<HTMLElement>("button"));
  };
  const close = () => {
    if (saving) return;
    dialog.close();
    cleanup();
  };
  dialog.addEventListener("close", cleanup);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("keydown", (event) => trapDialogFocus(event, close));
  function paint() {
    render(
      html`<header class="mcp-dialog-head"><h2 id="mcp-delete-title">Delete ${connection.name}?</h2></header>
        <div class="mcp-delete-body">
          <p>This removes the connection and shared access for all recipients. It cannot be undone.</p>
          ${failure ? html`<p class="mcp-dialog-error" role="alert">${failure}</p>` : nothing}
        </div>
        <footer class="mcp-dialog-footer">
          <div class="mcp-dialog-actions">
            <button type="button" data-dialog-cancel ?disabled=${saving} @click=${close}>Cancel</button>
            <button
              type="button"
              class="danger"
              ?disabled=${saving}
              @click=${async () => {
                saving = true;
                failure = "";
                paint();
                try {
                  await api(`/api/mcp-connections/${connection.id}`, { method: "DELETE" });
                  inventory.connections = inventory.connections.filter((row) => row.id !== connection.id);
                  if (shareDraft?.id === connection.id) shareDraft = null;
                  if (selected === connection.id) navigate(null);
                  notice = "Connection deleted.";
                  error = false;
                  await renderMcp();
                  saving = false;
                  close();
                } catch (error) {
                  failure = errMessage(error);
                  saving = false;
                  paint();
                }
              }}
            >
              ${saving ? "Deleting…" : "Delete connection"}
            </button>
          </div>
        </footer>`,
      dialog,
    );
  }
  paint();
  dialog.showModal();
  focusDialogCancel(dialog);
}
function draw() {
  if (appState.currentView !== "mcp" || !host) return;
  const connection = inventory.connections.find((row) => row.id === selected);
  const rows = inventory.connections.filter((row) => {
    const mine = row.canManage;
    const project = row.access.some((right) => right.scopeId.startsWith("group:"));
    return (
      (filter === "all" ||
        (filter === "mine" && mine) ||
        (filter === "shared" && !mine && row.access.some((right) => right.scopeId.startsWith("personal:"))) ||
        (filter === "projects" && project)) &&
      (!projectFilter || row.access.some((right) => right.scopeId === projectFilter)) &&
      `${row.name} ${row.url}`.toLowerCase().includes(search.toLowerCase())
    );
  });
  const catalog = rows.map(
    (row) =>
      html`<section class="mcp-card">
        <div class="mcp-entry-heading">
          <h2>
            <a
              href=${deepLinkPath(UI_BASE, "mcp", null, null, row.id)}
              @click=${(event: MouseEvent) => {
                if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                event.preventDefault();
                navigate(row.id);
              }}
              >${row.name}</a
            >
          </h2>
          ${
            row.canManage
              ? html`<details
                  class="mcp-entry-menu"
                  @keydown=${(event: KeyboardEvent) => {
                    if (event.key === "Escape") {
                      const menu = event.currentTarget as HTMLDetailsElement;
                      menu.open = false;
                      menu.querySelector("summary")?.focus();
                    }
                  }}
                >
                  <summary aria-label=${`Actions for ${row.name}`}>Actions</summary>
                  <div>
                    <button type="button" ?disabled=${busy} @click=${() => navigate(row.id)}>Manage</button>
                    <button type="button" class="danger" ?disabled=${busy} @click=${() => deleteConnection(row)}>
                      Delete
                    </button>
                  </div>
                </details>`
              : nothing
          }
        </div>
        <p>${new URL(row.url).host} · ${row.status ?? (row.enabled ? row.accountStatus : "Disabled")}</p>
        <p>
          ${row.access.map((right) => projectName(right.scopeId)).join(", ")} · ${row.canManage ? "Owner" : "Use only"}
        </p>
        ${row.access.filter((right) => right.scopeId.startsWith("group:")).map((right) => button(`Open ${projectName(right.scopeId)}`, () => openProject(right.scopeId)))}
      </section>`,
  );
  render(
    html`<div class="mcp-content" aria-busy=${busy}>
      ${notice ? html`<p class=${error ? "mcp-notice error" : "mcp-notice"} role=${error ? "alert" : "status"}>${notice}</p>` : nothing}
      ${
        selected && connection
          ? detail(connection)
          : html`
              <div class="mcp-heading">
                <div>
                  <h1>MCP</h1>
                  <p>Connections you can use with QM</p>
                </div>
                ${button("Add MCP", () => {
                  adding = true;
                  draw();
                })}
              </div>
              ${adding ? addForm() : nothing}
              <div class="mcp-filters">
                <label
                  >Search<input
                    type="search"
                    .value=${search}
                    @input=${(event: Event) => {
                      search = (event.target as HTMLInputElement).value;
                      draw();
                    }}
                /></label>
                <label
                  >Access<select
                    .value=${filter}
                    @change=${(event: Event) => {
                      filter = (event.target as HTMLSelectElement).value;
                      draw();
                    }}
                  >
                    <option value="all">All</option>
                    <option value="mine">Mine</option>
                    <option value="shared">Shared with me</option>
                    <option value="projects">Projects</option>
                  </select></label
                >
                <label
                  >Project<select
                    .value=${projectFilter}
                    @change=${(event: Event) => {
                      projectFilter = (event.target as HTMLSelectElement).value;
                      draw();
                    }}
                  >
                    <option value="">All projects</option>
                    ${inventory.projects.map((project) => html`<option value=${project.scopeId}>${project.name}</option>`)}
                  </select></label
                >
              </div>
              ${busy && !rows.length ? html`<p role="status">Loading MCP connections…</p>` : nothing}
              ${!busy && !rows.length ? html`<section class="mcp-card"><p>No connections match. Add an MCP server or ask its owner to share it.</p></section>` : nothing}
              ${catalog}
              ${
                inventory.legacy.length
                  ? html`<section class="mcp-card">
                      <h2>Legacy instance-wide</h2>
                      <p>These connections are managed by an administrator.</p>
                      ${inventory.legacy.map((row) => html`<p>${row.name} · ${row.enabled ? "Enabled" : "Disabled"}</p>`)}
                    </section>`
                  : nothing
              }
            `
      }
      <div class="mcp-actions">
        ${selected && !connection ? button("Disconnect my account", () => void action(() => api(`/api/mcp-connections/${encodeURIComponent(selected!)}/account`, { method: "DELETE" }), "Your saved account was disconnected.")) : nothing}
        ${button("Refresh", () => void renderMcp())}${button("Keychain", () => switchView("keychain"))}
      </div>
    </div>`,
    host,
  );
}
