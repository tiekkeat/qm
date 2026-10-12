import { html, nothing, render } from "lit";
import { api, type CoreContext } from "./core-bridge";
import { appState, switchView } from "./shell";
import { startNewChat } from "./sessions";
import { scopedSession } from "./session-scope";
import { listPageTpl } from "./list-page";
import { errMessage } from "../../chassis/src/errors";
import type { AgentView, AgentPackage } from "./agent-types";
import "./agents.css";
let rows: AgentView[] = [];
let contexts: CoreContext[] = [];
let current: AgentView | null = null;
let draft: AgentPackage | null = null;
let scope = "";
let deleted = false;
let search = "";
let notice = "";
let busy = false;
let target = "";
let role = "user";
let grants: Array<{ granteeScopeId: string; permission: string }> = [];
let comparison = "";
let skillId = "";
let skillOptions: Array<{ id: string; name: string }> = [];
let generation = 0;
let editorGeneration = 0;
let examplesText = "[]";
let pendingId: string | null = null;
let host: HTMLDivElement | null = null;
let loading = false;
export function openAgentById(id: string) {
  pendingId = id;
}
const personal = () => `personal:${appState.me?.user}`;
function agentStatus(a: AgentView) {
  if (a.deleted) return "Deleted";
  if (a.available) return `Published v${a.publishedVersion}`;
  return a.canEdit ? "Draft" : "Unavailable (retained history)";
}
function agentRole(a: AgentView) {
  if (a.canManage) return "Owner";
  return a.canEdit ? "Contributor" : "User";
}
function emptyPackage(): AgentPackage {
  return {
    name: "",
    description: "",
    instructions: "",
    files: [],
    allowedTools: null,
    requiredTools: [],
    examples: [],
  };
}
async function mutate(action: string, input: Record<string, unknown> = {}) {
  if (busy) return;
  if (action === "save" || action === "create") {
    try {
      draft!.examples = JSON.parse(examplesText);
    } catch {
      notice = "Examples must be valid JSON.";
      draw();
      return;
    }
  }
  const seq = editorGeneration;
  busy = true;
  notice = "";
  draw();
  try {
    const response = await api<AgentView>(current ? `/api/agents/${current.id}` : "/api/agents", {
      method: action === "delete" ? "DELETE" : "POST",
      body: JSON.stringify({ scopeId: scope || personal(), action, ...input }),
    });
    if (seq !== editorGeneration) return;
    if (action === "delete") {
      current = null;
      draft = null;
      notice = "Agent deleted. Workspace files, memory, skills and sandboxes are preserved.";
    } else if (response.package) {
      current = response;
      if (["save", "create", "restore", "import-skill"].includes(action)) {
        draft = structuredClone(response.package);
        examplesText = JSON.stringify(draft.examples, null, 2);
        comparison = "";
      }
    }
    await loadRows();
    if (seq !== editorGeneration) return;
    if (current?.canManage) await loadGrants();
  } catch (e) {
    if (seq === editorGeneration) notice = errMessage(e);
  } finally {
    if (seq === editorGeneration) {
      busy = false;
      draw();
    }
  }
}
async function loadRows() {
  const query = new URLSearchParams();
  if (scope) query.set("scopeId", scope);
  if (deleted) query.set("deleted", "1");
  const seq = generation;
  const scopeAtStart = scope;
  const deletedAtStart = deleted;
  const result = await api<{ agents: AgentView[] }>(`/api/agents?${query}`);
  if (seq === generation && scope === scopeAtStart && deleted === deletedAtStart) rows = result.agents;
}
async function loadGrants() {
  if (!current) return;
  const id = current.id;
  const seq = editorGeneration;
  const result = await api<{ grants: typeof grants }>(`/api/agents/${id}`, {
    method: "POST",
    body: JSON.stringify({ action: "grants" }),
  });
  if (current?.id === id && seq === editorGeneration) grants = result.grants;
}
async function open(a: AgentView) {
  const seq = ++editorGeneration;
  busy = false;
  current = a;
  draft = structuredClone(a.package);
  examplesText = JSON.stringify(draft.examples, null, 2);
  comparison = "";
  grants = [];
  notice = "";
  draw();
  if (host) host.scrollTop = 0;
  if (a.canManage) {
    try {
      await loadGrants();
      draw();
    } catch (e) {
      if (seq === editorGeneration) {
        notice = errMessage(e);
        draw();
      }
    }
  }
}
function change(field: keyof AgentPackage, value: unknown) {
  if (draft) (draft as unknown as Record<string, unknown>)[field] = value;
}
function input(label: string, value: string, onInput: (value: string) => void, multiline = false, readOnly = false) {
  return html`<label class="agent-field"
    ><span>${label}</span
    >${multiline ? html`<textarea .value=${value} ?readonly=${readOnly || busy} @input=${(e: Event) => onInput((e.target as HTMLTextAreaElement).value)}></textarea>` : html`<input .value=${value} ?readonly=${readOnly || busy} @input=${(e: Event) => onInput((e.target as HTMLInputElement).value)} />`}</label
  >`;
}
function usableScope() {
  return scopes().some((c) => c.scopeId === scope) ? scope : personal();
}
function scopes() {
  return contexts.filter(
    (c) => c.kind === "personal" || (!!c.project && (!c.project.lifecycle || c.project.lifecycle === "active")),
  );
}
async function useAgent(test = false) {
  if (!current || busy) return;
  const seq = editorGeneration;
  const selection = {
    id: current.id,
    version: test ? current.version : current.publishedVersion!,
    ...(test ? { test: true } : {}),
  };
  if (!selection.version) return;
  const destination = usableScope();
  const threadRef = `web:${appState.me?.user}:${crypto.randomUUID()}`;
  busy = true;
  notice = "";
  draw();
  try {
    await api("/api/agents/binding", {
      method: "POST",
      body: JSON.stringify({ scopeId: destination, threadRef, selection }),
    });
    if (seq !== editorGeneration || appState.currentView !== "agents") return;
    switchView("chats");
    startNewChat(destination === personal() ? null : destination, null, threadRef);
  } catch (e) {
    if (seq === editorGeneration) notice = errMessage(e);
  } finally {
    if (seq === editorGeneration) {
      busy = false;
      draw();
    }
  }
}
async function setDefault(id: string | null) {
  if (busy) return;
  const seq = editorGeneration;
  busy = true;
  notice = "";
  draw();
  try {
    await api("/api/agents/binding", {
      method: "POST",
      body: JSON.stringify({
        scopeId: usableScope(),
        default: true,
        selection: id ? { id, version: current!.publishedVersion } : null,
      }),
    });
    if (seq === editorGeneration) notice = "Default updated for new conversations.";
  } catch (e) {
    if (seq === editorGeneration) notice = errMessage(e);
  } finally {
    if (seq === editorGeneration) {
      busy = false;
      draw();
    }
  }
}
async function upload(event: Event) {
  const files = (event.target as HTMLInputElement).files;
  if (!draft || !files) return;
  const destination = draft;
  const seq = editorGeneration;
  for (const file of Array.from(files)) {
    if (file.size > 3_000_000) {
      notice = "Files must be smaller than 3 MB.";
      continue;
    }
    const data = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (const byte of data) binary += String.fromCharCode(byte);
    if (destination !== draft || seq !== editorGeneration) return;
    destination.files.push({
      path: `references/${file.name}`,
      content: btoa(binary),
      encoding: "base64",
      mimetype: file.type,
    });
  }
  draw();
}
function draw() {
  if (appState.currentView !== "agents" || !appState.mainEl) return;
  if (!host || host.parentElement !== appState.mainEl) {
    host = document.createElement("div");
    host.className = "agents-page";
    appState.mainEl.replaceChildren(host);
  }
  if (appState.listEl) render(nothing, appState.listEl);
  if (!draft) {
    const filtered = rows.filter(
      (a) =>
        (deleted || !a.deleted) &&
        `${a.name} ${a.description} ${a.ownerScopeId}`.toLowerCase().includes(search.toLowerCase()),
    );
    render(
      html`<section class="agents-content">
        ${listPageTpl({
          title: "Agents",
          subtitle: "Create specialists, publish versions, and share with users or projects.",
          action: {
            label: "Create agent",
            onClick: () => {
              editorGeneration++;
              busy = false;
              current = null;
              scope = usableScope();
              draft = emptyPackage();
              examplesText = "[]";
              comparison = "";
              draw();
              if (host) host.scrollTop = 0;
            },
          },
          search: {
            value: search,
            placeholder: "Search agents…",
            onInput: (value) => {
              search = value;
              draw();
            },
          },
          filters: html`<div class="agent-filters">
            <label
              >Workspace
              <select
                aria-label="Agent workspace"
                .value=${scope}
                @change=${async (e: Event) => {
                  scope = (e.target as HTMLSelectElement).value;
                  await renderAgents(false);
                }}
              >
                <option value="">All available</option>
                ${scopes().map((c) => html`<option value=${c.scopeId}>${c.name || c.scopeId}</option>`)}
              </select></label
            ><label
              ><input
                type="checkbox"
                .checked=${deleted}
                @change=${async (e: Event) => {
                  deleted = (e.target as HTMLInputElement).checked;
                  await renderAgents(false);
                }}
              />Include deleted</label
            >
          </div>`,
          rows: loading
            ? []
            : filtered.map(
                (a) =>
                  html`<button class="agent-row" @click=${() => void open(a)}>
                    <strong>${a.name}</strong><span>${a.description}</span
                    ><small>${a.ownerScopeId} · ${agentStatus(a)} · ${agentRole(a)}</small>
                  </button>`,
              ),
          empty: loading
            ? html`<span role="status">Loading agents…</span>`
            : "No agents yet. Ask QM to create an agent in chat, or use Create agent.",
        })}${notice ? html`<div role="alert" class="agent-notice">${notice}</div>` : nothing}
      </section>`,
      host,
    );
    return;
  }
  const readOnly = !!current && !current.canEdit;
  const latest = current?.revisions.at(-1)?.version ?? 1;
  render(
    html`<section class="agent-editor">
      <button
        class="btn"
        @click=${() => {
          editorGeneration++;
          busy = false;
          draft = null;
          current = null;
          draw();
          if (host) host.scrollTop = 0;
        }}
      >
        ← Agents
      </button>
      <h1>${current ? current.name : "Create agent"}</h1>
      ${notice ? html`<p role="alert" class="agent-notice">${notice}</p>` : nothing}
      ${
        current
          ? html`<p>
              ${current.ownerScopeId} · /agent ${current.slug} ·
              v${current.version}${current.deleted ? " · Deleted (read-only history)" : ""}
            </p>`
          : html`<label class="agent-field"
              >Owner workspace
              <select
                ?disabled=${busy}
                .value=${scope || personal()}
                @change=${(e: Event) => (scope = (e.target as HTMLSelectElement).value)}
              >
                ${scopes().map((c) => html`<option value=${c.scopeId}>${c.name || c.scopeId}</option>`)}
              </select></label
            >`
      }
      ${input("Name", draft.name, (v) => change("name", v), false, readOnly)}${input("Description", draft.description, (v) => change("description", v), false, readOnly)}${input("Instructions (AGENT.md)", draft.instructions, (v) => change("instructions", v), true, readOnly)}
      <label class="agent-field"
        >Tool access
        <select
          ?disabled=${readOnly || busy}
          .value=${draft.allowedTools === null ? "all" : "limited"}
          @change=${(e: Event) => {
            change("allowedTools", (e.target as HTMLSelectElement).value === "all" ? null : []);
            draw();
          }}
        >
          <option value="all">Use workspace permissions</option>
          <option value="limited">Only listed tools or actions</option>
        </select></label
      >
      ${
        draft.allowedTools !== null
          ? input(
              "Allowed tools/actions, comma separated",
              draft.allowedTools.join(", "),
              (v) =>
                change(
                  "allowedTools",
                  v
                    .split(",")
                    .map((x) => x.trim())
                    .filter(Boolean),
                ),
              false,
              readOnly,
            )
          : nothing
      }
      <p class="muted">
        Restrictions reduce workspace access. Use files.read or skills.read for inspection. Restricted agents cannot
        delegate, switch runtime, or create background agent work.
      </p>
      ${input(
        "Required tools / MCP tool names, comma separated",
        draft.requiredTools.join(", "),
        (v) =>
          change(
            "requiredTools",
            v
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean),
          ),
        false,
        readOnly,
      )}
      ${input("Examples (JSON list of task and expected)", examplesText, (v) => (examplesText = v), true, readOnly)}
      <h2>Package files</h2>
      ${draft.files.map(
        (f, i) =>
          html`<div class="agent-package-file">
            ${input("Path", f.path, (v) => (f.path = v), false, readOnly)}${f.encoding === "base64" ? html`<p>Binary · ${f.mimetype || "file"} · ${f.content.length} encoded bytes</p>` : input("Content", f.content, (v) => (f.content = v), true, readOnly)}${
              !readOnly
                ? html`<button
                    class="btn"
                    ?disabled=${busy}
                    @click=${() => {
                      draft!.files.splice(i, 1);
                      draw();
                    }}
                  >
                    Remove file
                  </button>`
                : nothing
            }
          </div>`,
      )}
      ${
        !readOnly
          ? html`<button
                class="btn"
                ?disabled=${busy}
                @click=${() => {
                  draft!.files.push({ path: "references/new.md", content: "" });
                  draw();
                }}
              >
                Add text file</button
              ><label class="btn"
                >Upload references<input type="file" ?disabled=${busy} multiple @change=${(e: Event) => void upload(e)}
              /></label>`
          : nothing
      }
      <div class="agent-actions">
        ${!readOnly ? html`<button class="btn primary" ?disabled=${busy} @click=${() => void mutate(current ? "save" : "create", { package: draft, expectedVersion: latest })}>${current ? "Save new version" : "Create draft"}</button>` : nothing}
        ${current?.canEdit ? html`<button class="btn" ?disabled=${busy} @click=${() => void mutate("publish", { version: current!.version })}>Publish saved v${current.version}</button><button class="btn" ?disabled=${busy} @click=${() => void useAgent(true)}>Test saved v${current.version} in chat</button>` : nothing}
        ${current?.available ? html`<button class="btn" @click=${() => void useAgent()}>Use published agent</button><button class="btn" @click=${() => void setDefault(current!.id)}>Set workspace default</button>` : nothing}
        <button class="btn" @click=${() => void setDefault(null)}>Clear workspace default</button>
      </div>
      ${
        current
          ? html`<h2>Versions</h2>
              ${current.revisions.map(
                (v) =>
                  html`<div class="agent-version">
                    v${v.version} · ${v.author} · ${new Date(v.at).toLocaleString()} ·
                    ${v.summary}${v.publishedAt ? " · Published" : ""}<button
                      class="btn"
                      @click=${async () => {
                        const id = current!.id;
                        const seq = editorGeneration;
                        try {
                          const old = await api<AgentView>(`/api/agents/${id}?version=${v.version}`);
                          if (id !== current?.id || seq !== editorGeneration) return;
                          comparison = JSON.stringify(old.package, null, 2);
                          draw();
                        } catch (e) {
                          if (seq === editorGeneration && id === current?.id) {
                            notice = errMessage(e);
                            draw();
                          }
                        }
                      }}
                    >
                      Compare v${v.version}</button
                    >${current?.canEdit ? html`<button class="btn" ?disabled=${busy} @click=${() => void mutate("restore", { version: v.version, expectedVersion: latest })}>Restore as new revision</button>` : nothing}
                  </div>`,
              )}${
                comparison
                  ? html`<div class="agent-comparison">
                      <div>
                        <h3>Selected revision</h3>
                        <pre>${comparison}</pre>
                      </div>
                      <div>
                        <h3>Current editor</h3>
                        <pre>${JSON.stringify(draft, null, 2)}</pre>
                      </div>
                    </div>`
                  : nothing
              }`
          : nothing
      }
      ${
        current?.canEdit
          ? html`<h2>Import skill snapshot</h2>
              <select
                aria-label="Skill snapshot"
                .value=${skillId}
                @change=${(e: Event) => (skillId = (e.target as HTMLSelectElement).value)}
              >
                <option value="">Select a visible skill</option>
                ${skillOptions.map((s) => html`<option value=${s.id}>${s.name}</option>`)}</select
              ><button
                class="btn"
                ?disabled=${busy || !skillId}
                @click=${() => void mutate("import-skill", { skillId, expectedVersion: latest })}
              >
                Import into new version
              </button>
              <h2>Suggestions</h2>
              ${current.proposals.map((p) => html`<p>${p.author}: ${p.text}</p>`)}`
          : nothing
      }
      ${
        current && !current.deleted && !current.canEdit
          ? html`<button
              class="btn"
              @click=${() => {
                const text = prompt("Suggest an improvement for the agent owner");
                if (text) void mutate("suggest", { text });
              }}
            >
              Suggest an improvement
            </button>`
          : nothing
      }
      ${
        current?.canManage
          ? html`<h2>Sharing</h2>
              <p>
                User can read and run published versions. Contributor can also edit and publish. Sharing grants the
                package only.
              </p>
              ${grants.map((g) => html`<p>${g.granteeScopeId} · ${g.permission === "write" ? "Contributor" : "User"}<button class="btn" @click=${() => void mutate("share", { scopeId: g.granteeScopeId, role: null })}>Remove access</button></p>`)}${input("Recipient email or project scope ID", target, (v) => (target = v))}<select
                aria-label="Agent share role"
                .value=${role}
                @change=${(e: Event) => (role = (e.target as HTMLSelectElement).value)}
              >
                <option value="user">User</option>
                <option value="contributor">Contributor</option></select
              ><button
                class="btn"
                ?disabled=${busy}
                @click=${() => void mutate("share", { scopeId: target.includes(":") ? target : `personal:${target.trim()}`, role })}
              >
                Share
              </button>
              <h2>Delete agent</h2>
              <p>
                Retain read-only history. Remove shared use and defaults. Your chats, files, memory, skills and sandbox
                stay in the workspace.
              </p>
              <button
                class="btn danger"
                ?disabled=${busy}
                @click=${() => {
                  if (confirm(`Delete ${current!.name}? Shared users will lose access. Workspace data is preserved.`))
                    void mutate("delete", { confirm: true });
                }}
              >
                Delete agent
              </button>`
          : nothing
      }
    </section>`,
    host,
  );
}
export async function renderAgents(reset = true) {
  if (appState.currentView !== "agents" || !appState.mainEl) return;
  const seq = ++generation;
  if (reset) {
    editorGeneration++;
    busy = false;
    scope = scopedSession.active?.scopeId ?? "";
    current = null;
    draft = null;
    notice = "";
  }
  loading = true;
  notice = "";
  draw();
  if (reset && host) host.scrollTop = 0;
  try {
    const [list, skills] = await Promise.all([
      api<{ contexts: CoreContext[] }>("/api/contexts"),
      api<{ skills?: Array<{ id: string; name: string }> }>("/api/skills"),
    ]);
    if (seq !== generation) return;
    contexts = list.contexts;
    skillOptions = skills.skills ?? [];
    await loadRows();
    if (seq !== generation) return;
    loading = false;
    if (pendingId) {
      const id = pendingId;
      pendingId = null;
      const agent = rows.find((a) => a.id === id);
      if (agent) await open(agent);
    }
    draw();
  } catch (e) {
    if (seq === generation) {
      loading = false;
      rows = [];
      notice = errMessage(e);
      draw();
    }
  }
}
