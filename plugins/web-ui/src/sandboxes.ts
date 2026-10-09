import { html, nothing, type TemplateResult } from "lit";
import { api, type CoreContext, type CoreProject } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";

interface SandboxRow {
  id: string;
  name: string;
  backend: string;
  state: string;
  availableActions?: string[];
  executionBlocked?: boolean;
  cleanupPending?: boolean;
  error?: string;
}
interface Inventory {
  sandboxes: SandboxRow[];
  defaultSandboxId: string | null;
  manageable: boolean;
  jobs: Array<{ processId: string; sandboxId?: string; purpose: string }>;
  providers: Array<{ name: string; actions: string[] }>;
  statuses?: Record<string, unknown>;
}
const state = {
  scope: "",
  inventory: null as Inventory | null,
  notice: "",
  loading: false,
  busy: false,
  name: "",
  backend: "",
  archive: null as { memory: string; skills: Array<{ id: string; name: string; body: string }> } | null,
};
let sequence = 0;
export function resetSandboxes(): void {
  sequence++;
  Object.assign(state, {
    scope: "",
    inventory: null,
    notice: "",
    loading: false,
    busy: false,
    name: "",
    backend: "",
    archive: null,
  });
}
export async function loadSandboxes(context: CoreContext, redraw: () => void): Promise<void> {
  const seq = ++sequence;
  state.scope = context.scopeId;
  state.loading = true;
  state.notice = "";
  try {
    const inventory = await api<Inventory>(`/api/scopes/${encodeURIComponent(context.scopeId)}/sandboxes`);
    if (seq !== sequence) return;
    state.inventory = inventory;
    state.backend = inventory.providers[0]?.name ?? "";
    if (context.project?.lifecycle === "archived") {
      const archive = await api<typeof state.archive>(
        `/api/projects/${encodeURIComponent(context.project.id)}/archive`,
      );
      if (seq !== sequence) return;
      state.archive = archive;
    }
  } catch (error) {
    if (seq === sequence) state.notice = errMessage(error, "Couldn't load sandboxes. Refresh to retry.");
  } finally {
    if (seq === sequence) {
      state.loading = false;
      redraw();
    }
  }
}
async function act(context: CoreContext, input: Record<string, unknown>, redraw: () => void): Promise<void> {
  if (state.busy) return;
  const seq = sequence;
  state.busy = true;
  state.notice = "";
  redraw();
  try {
    const inventory = await api<Inventory>(`/api/scopes/${encodeURIComponent(context.scopeId)}/sandboxes`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (seq !== sequence) return;
    state.inventory = inventory;
    state.name = "";
  } catch (error) {
    if (seq === sequence) state.notice = errMessage(error, "Couldn't finish. Refresh and retry.");
  } finally {
    if (seq === sequence) {
      state.busy = false;
      redraw();
    }
  }
}
function retire(context: CoreContext, row: SandboxRow, redraw: () => void): void {
  const jobs = state.inventory?.jobs.filter((job) => !job.sandboxId || job.sandboxId === row.id) ?? [];
  if (
    !window.confirm(
      `Retire “${row.name}”?\n\nThis permanently deletes its disk files and installed components. ${jobs.length ? `Stop ${jobs.length} running jobs: ${jobs.map((job) => job.purpose).join(", ")}.` : ""}\n\nSaved Files, memory, registered skills, and chats remain. Future chat tasks may create a new sandbox.`,
    )
  )
    return;
  void act(context, { action: "retire", sandboxId: row.id, confirm: true }, redraw);
}
export function sandboxSection(context: CoreContext, redraw: () => void): TemplateResult | typeof nothing {
  if (context.kind !== "personal" && !context.project) return nothing;
  const inventory = state.scope === context.scopeId ? state.inventory : null;
  const active = !context.project?.lifecycle || context.project.lifecycle === "active";
  return html`<section class="context-panel sandbox-panel" aria-labelledby="sandbox-title">
    <div class="context-panel-heading">
      <h2 class="context-panel-title" id="sandbox-title">Sandboxes</h2>
      <button class="btn" ?disabled=${state.loading || state.busy} @click=${() => void loadSandboxes(context, redraw)}>
        Refresh
      </button>
    </div>
    <p class="context-hint">
      ${context.kind === "personal" ? "Your personal computers. Project members cannot access them automatically." : "Shared computers owned by this project. Only the project owner manages them."}
    </p>
    ${state.loading ? html`<p role="status">Loading…</p>` : nothing}
    ${state.notice ? html`<p role="alert">${state.notice}</p>` : nothing}
    ${
      inventory
        ? html`${inventory.sandboxes.map(
            (row) =>
              html`<div class="sandbox-row">
                <div>
                  <strong>${row.name}</strong>
                  ${row.id === inventory.defaultSandboxId ? html`<span class="badge">Default</span>` : nothing}
                  <div class="context-hint">
                    ${row.backend} ·
                    ${row.executionBlocked && row.state !== "retired" ? "Retirement pending" : row.state}${row.cleanupPending ? " · Cleanup pending" : ""}
                  </div>
                </div>
                ${row.error ? html`<p role="alert">Cleanup or provisioning failed. Retry the supported action; contact the operator if it continues.</p>` : nothing}
                ${
                  inventory.manageable || row.availableActions?.includes("status")
                    ? html`<div class="sandbox-actions">
                        ${inventory.manageable && active && row.state !== "retired" && !row.executionBlocked ? html`<button class="btn" ?disabled=${state.busy} @click=${() => void act(context, { action: "default", sandboxId: row.id === inventory.defaultSandboxId ? null : row.id }, redraw)}>${row.id === inventory.defaultSandboxId ? "Clear default" : "Use as default"}</button>` : nothing}
                        ${active && row.availableActions?.includes("status") && !row.executionBlocked ? html`<button class="btn" ?disabled=${state.busy} @click=${() => void act(context, { action: "status", sandboxId: row.id }, redraw)}>Status</button>` : nothing}
                        ${
                          inventory.manageable &&
                          active &&
                          row.availableActions?.includes("restart") &&
                          !row.executionBlocked
                            ? html`<button
                                class="btn"
                                ?disabled=${state.busy}
                                @click=${() => window.confirm(`Restart “${row.name}”? Running processes will stop.`) && void act(context, { action: "restart", sandboxId: row.id }, redraw)}
                              >
                                Restart
                              </button>`
                            : nothing
                        }
                        ${inventory.manageable && row.availableActions?.includes("retire") ? html`<button class="btn danger" ?disabled=${state.busy} @click=${() => retire(context, row, redraw)}>${row.executionBlocked || row.cleanupPending ? "Retry retirement" : "Retire"}</button>` : nothing}
                      </div>`
                    : nothing
                }
                ${inventory.statuses?.[row.id] ? html`<pre class="sandbox-status">${JSON.stringify(inventory.statuses[row.id], null, 2)}</pre>` : nothing}
              </div>`,
          )}
          ${inventory.sandboxes.length === 0 ? html`<p class="context-hint">No sandbox yet. A chat task that needs a computer can create one.</p>` : nothing}
          ${
            active && inventory.manageable
              ? html`<form
                  class="sandbox-create"
                  @submit=${(event: SubmitEvent) => {
                    event.preventDefault();
                    void act(context, { action: "create", name: state.name, backend: state.backend }, redraw);
                  }}
                >
                  <label
                    >Name<input
                      maxlength="120"
                      .value=${state.name}
                      @input=${(event: InputEvent) => {
                        state.name = (event.target as HTMLInputElement).value;
                      }}
                  /></label>
                  <label
                    >Provider<select
                      .value=${state.backend}
                      @change=${(event: Event) => {
                        state.backend = (event.target as HTMLSelectElement).value;
                      }}
                    >
                      ${inventory.providers.filter((provider) => provider.actions.includes("create")).map((provider) => html`<option value=${provider.name}>${provider.name}</option>`)}
                    </select></label
                  >
                  <button class="btn" ?disabled=${state.busy || !state.backend}>Create sandbox</button>
                  <p class="context-hint">Creating a sandbox does not change your default.</p>
                </form>`
              : nothing
          }`
        : nothing
    }
  </section>`;
}
export function archiveSection(context: CoreContext): TemplateResult | typeof nothing {
  if (context.project?.lifecycle !== "archived") return nothing;
  return html`<section class="context-panel">
    <h2>Saved memory</h2>
    <pre class="sandbox-status">${state.archive?.memory || "No saved memory."}</pre>
    <h2>Registered skills</h2>
    ${
      state.archive?.skills.map(
        (skill) =>
          html`<details>
            <summary>${skill.name}</summary>
            <pre class="sandbox-status">${skill.body}</pre>
          </details>`,
      ) ?? nothing
    }
  </section>`;
}
export function projectDeletionSection(
  context: CoreContext,
  owner: boolean,
  redraw: () => void,
  update: (project: CoreProject) => void,
): TemplateResult | typeof nothing {
  const project = context.project;
  if (!project || !owner || project.lifecycle === "archived") return nothing;
  const remove = async () => {
    if (state.busy) return;
    const seq = sequence;
    state.busy = true;
    state.notice = "";
    redraw();
    try {
      const preview = await api<{
        sandboxes: SandboxRow[];
        jobs: Inventory["jobs"];
        apps: Array<{ name: string }>;
        automations: number;
        blockers?: Array<{ name: string; reason: string }>;
      }>(`/api/projects/${encodeURIComponent(project.id)}/deletion`);
      if (seq !== sequence) return;
      if (preview.blockers?.length) {
        state.notice = preview.blockers.map((blocker) => `${blocker.name}: ${blocker.reason}`).join("\n");
        return;
      }
      if (
        !window.confirm(
          `Delete “${project.name}”? This cannot be restored.\n\nRetire ${preview.sandboxes.length} sandboxes: ${preview.sandboxes.map((row) => row.name).join(", ") || "none"}. Sandbox disk files and installed components are permanently deleted.\nStop ${preview.jobs.length} running jobs and ${preview.automations} automations.\nTransfer ${preview.apps.length} published apps to your personal ownership: ${preview.apps.map((app) => app.name).join(", ") || "none"}. They keep running.\n\nChats, saved Files, memory, and registered skills remain in a read-only archive for current members.`,
        )
      )
        return;
      const result = await api<{ project: CoreProject }>(`/api/projects/${encodeURIComponent(project.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ confirm: true }),
      });
      if (seq !== sequence) return;
      update(result.project);
      state.busy = false;
      await loadSandboxes({ ...context, project: result.project }, redraw);
    } catch (error) {
      if (seq === sequence) state.notice = errMessage(error, "Couldn't delete the project. Refresh and retry.");
    } finally {
      if (seq === sequence) {
        state.busy = false;
        redraw();
      }
    }
  };
  return html`<section class="context-panel">
    <h2 class="context-panel-title">Delete project</h2>
    <p class="context-hint">
      Retire project sandboxes and stop project work. Saved data remains in a permanent read-only archive.
    </p>
    ${project.deletion?.error ? html`<p role="alert">${project.deletion.error}</p>` : nothing}${project.deletion ? html`<p class="context-hint">Completed: ${project.deletion.completed.join(", ") || "Preparing cleanup"}</p>` : nothing}<button
      class="btn danger"
      ?disabled=${state.busy}
      @click=${() => void remove()}
    >
      ${project.lifecycle === "deleting" ? "Retry project deletion" : "Delete project"}
    </button>
  </section>`;
}
