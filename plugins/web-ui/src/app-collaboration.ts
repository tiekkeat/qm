import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { Github, Check, Copy, ExternalLink, RefreshCw, X, GitBranch, ShieldCheck } from "lucide";
import { api, withBase } from "./core-bridge";
import { copyText, icon } from "./ui";
import { restoreDialogFocus } from "./dialog-focus";
import type { DeploymentView } from "./deploy-view";
import {
  CollaborationState,
  connectionLabel,
  type DetailTab,
  type Release,
  type Preview,
  type Mode,
  type Change,
  type Operation,
} from "./app-collaboration-state";

const states = new Map<string, CollaborationState>();
export function collaborationState(id: string) {
  let s = states.get(id);
  if (!s) {
    s = new CollaborationState();
    states.set(id, s);
  }
  return s;
}
export const loadingIndicator = (label: string) =>
  html`<span class="app-loading" role="status"><span class="app-spinner" aria-hidden="true"></span>${label}</span>`;
const titles: Record<Mode, string> = {
  connect: "Connect your GitHub account",
  setup: "Connect a repository",
  create: "Create private repository",
  link: "Link existing repository",
  submit: "Submit to GitHub",
  import: "Import merged version",
  invite: "Invite a contributor",
  rollback: "Restore this version",
  edit: "Edit release details",
  unlink: "Unlink repository",
  "remove-access": "Remove repository access",
};
const labels: Partial<Record<Mode, string>> = {
  create: "Confirm private repository creation",
  link: "Confirm linking",
  import: "Confirm import and publish",
  submit: "Push and create PR",
  invite: "Send write-access invitation",
  rollback: "Restore this version",
  edit: "Save release details",
  unlink: "Unlink repository",
  "remove-access": "Remove QM-granted access",
};
function request(d: DeploymentView, action: string, input: Record<string, unknown>, signal?: AbortSignal) {
  return api(`/api/deployments/${encodeURIComponent(d.id)}/collaboration/${action}`, {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });
}
export async function refreshCollaboration(d: DeploymentView, redraw: () => void) {
  const s = collaborationState(d.id);
  if (s.reads.connection) return;
  await s.read(
    "connection",
    (signal) =>
      api<NonNullable<CollaborationState["collaboration"]>>(
        `/api/deployments/${encodeURIComponent(d.id)}/collaboration`,
        { signal },
      ),
    (value) => {
      s.collaboration = value;
      if (!value.error) s.lastChecked = Date.now();
    },
    redraw,
  );
}
export async function viewRelease(d: DeploymentView, release: Release, redraw: () => void, from = "") {
  const s = collaborationState(d.id);
  s.release = release;
  s.comparison = from;
  s.changes = undefined;
  s.events = undefined;
  await s.read(
    "release",
    (signal) =>
      api<{ changes: Change[]; events: CollaborationState["events"] }>(
        `/api/deployments/${encodeURIComponent(d.id)}/versions/${release.version}${from ? `?from=${encodeURIComponent(from)}` : ""}`,
        { signal },
      ),
    (result) => {
      s.changes = result.changes;
      s.events = result.events;
    },
    redraw,
  );
}
export function resetCollaborationStates() {
  states.forEach((s) => s.cancelReads());
  states.clear();
}
export function stopCollaborationReads(id: string) {
  states.get(id)?.cancelReads();
}
function diff(changes?: Change[]) {
  return changes
    ? html`<div class="app-diff">
        ${
          changes.length
            ? changes.map(
                (c) =>
                  html`<details>
                    <summary>${c.path}${c.sha === null ? html`<span class="badge">Deleted</span>` : nothing}</summary>
                    <div class="app-diff-columns">
                      <div>
                        <strong>Before</strong>
                        <pre>${c.before ?? "File absent"}</pre>
                      </div>
                      <div>
                        <strong>After</strong>
                        <pre>${c.after ?? "File absent"}</pre>
                      </div>
                    </div>
                  </details>`,
              )
            : html`<p class="hint">No source changes.</p>`
        }
      </div>`
    : nothing;
}
function sha(value: string, label = "Source SHA") {
  return html`<div class="app-sha">
    <span>${label}</span><code>${value}</code
    ><button
      class="btn"
      aria-label=${`Copy ${label}`}
      @click=${(e: Event) => void copyText(value, e.currentTarget as HTMLButtonElement)}
    >
      ${icon(Copy, 14)}
    </button>
  </div>`;
}
export function collaborationPanel(
  d: DeploymentView,
  redraw: () => void,
  refreshApp: () => Promise<void>,
  tab: DetailTab | "dialog",
) {
  const s = collaborationState(d.id),
    c = s.collaboration,
    linked = s.linked;
  const current = d.versions?.find((v) => v.version === (d.appliedVersion ?? d.currentVersion));
  const selected = s.release ?? current;
  const open = (mode: Mode, draft: Record<string, unknown> = {}) => {
    if (s.pending) return;
    s.opener = document.activeElement as HTMLElement;
    s.start(mode, draft);
    if (mode === "rollback" && s.release) void viewRelease(d, s.release, redraw, String(d.appliedVersion));
    redraw();
  };
  const close = () => {
    if (s.pending) return;
    s.reads.preview?.abort();
    s.mode = undefined;
    s.preview = undefined;
    s.revision++;
    redraw();
    restoreDialogFocus(s.opener, () => document.querySelector<HTMLElement>(".app-detail-tabs [aria-selected=true]"));
  };
  const change = (name: string, value: unknown) => {
    s.change(name, value);
    redraw();
  };
  const field = (name: string, label: string, multiline = false) =>
    html`<label class="app-field"
      >${label}${multiline ? html`<textarea .value=${String(s.draft[name] ?? "")} ?disabled=${!!s.pending} @input=${(e: Event) => change(name, (e.target as HTMLTextAreaElement).value)}></textarea>` : html`<input .value=${String(s.draft[name] ?? "")} ?disabled=${!!s.pending} @input=${(e: Event) => change(name, (e.target as HTMLInputElement).value)} />`}</label
    >`;
  const startSubmit = () =>
    selected &&
    open("submit", {
      version: selected.version,
      branch: `qm/v${selected.version}-${Date.now()}`,
      message: selected.commitMessage ?? selected.title ?? `Publish version ${selected.version}`,
      title: selected.title ?? "",
      description: selected.description ?? "",
      createPr: true,
      existingBranch: false,
    });
  const refresh = () => void refreshCollaboration(d, redraw);
  const execute = (extra: Record<string, unknown> = {}) => {
    const mode = s.mode;
    if (!mode) return;
    s.actionId ??= crypto.randomUUID();
    const input: Record<string, unknown> = {
      ...s.draft,
      ...extra,
      operationId: s.actionId,
      confirmed: true,
      ...(s.preview ? { expectedSha: s.preview.expectedSha, expectedVersion: s.preview.expectedVersion } : {}),
      ...(s.submissionId && mode === "import" ? { submissionId: s.submissionId } : {}),
    };
    void s
      .mutate(
        titles[mode],
        async () => {
          let result: { exportRequired?: boolean } | undefined;
          if (mode === "edit") {
            await api(`/api/deployments/${encodeURIComponent(d.id)}/versions/${input.version}`, {
              method: "PATCH",
              body: JSON.stringify({ title: input.title, description: input.description }),
            });
            if (s.release && s.release.version === input.version)
              s.release = { ...s.release, title: String(input.title), description: String(input.description) };
          } else if (mode === "rollback") {
            await api(`/api/deployments/${encodeURIComponent(d.id)}/rollback`, {
              method: "POST",
              body: JSON.stringify({ version: input.version, operationId: input.operationId }),
            });
          } else result = (await request(d, mode, input)) as { exportRequired?: boolean };
          s.mode = undefined;
          s.preview = undefined;
          await refreshApp();
          void refreshCollaboration(d, redraw);
          if (mode === "link" && result?.exportRequired) {
            s.pending = undefined;
            s.start("submit", {
              version: d.currentVersion,
              branch: `qm/v${d.currentVersion}-${Date.now()}`,
              message: selected?.commitMessage ?? "Export QM app",
              title: selected?.title ?? "Export QM app",
              description: selected?.description ?? "",
              createPr: true,
            });
          }
        },
        redraw,
      )
      .then((ok) => {
        if (ok && !s.mode)
          restoreDialogFocus(s.opener, () =>
            document.querySelector<HTMLElement>(".app-detail-tabs [aria-selected=true]"),
          );
      });
  };
  const preview = () => {
    const revision = s.revision,
      mode = s.mode,
      draft = { ...s.draft };
    const actions: Partial<Record<Mode, string>> = {
      create: "create-preview",
      link: "compare",
      import: "import-preview",
      invite: "contributor-access",
    };
    const action = mode ? (actions[mode] ?? "preview") : "preview";
    void s.read(
      "preview",
      (signal) =>
        request(
          d,
          action,
          { ...draft, ...(mode === "import" ? { submissionId: s.submissionId } : {}) },
          signal,
        ) as Promise<Preview>,
      (result) => {
        if (revision !== s.revision || mode !== s.mode) return;
        s.preview = result;
        if (result.identity) s.draft = { ...s.draft, expectedGitHubUserId: result.identity.id };
      },
      redraw,
    );
  };
  const error = (message?: string) =>
    message ? html`<div class="app-feedback error" role="alert">${message}</div>` : nothing;
  const status = connectionLabel(s);
  let accountAction = "GitHub connection options";
  if (c || s.errors.connection) accountAction = "Connect GitHub";
  if (c?.identity || status === "Reconnect required") accountAction = "Reconnect GitHub";
  const repositoryStatus = c ? "Not linked" : "Checking";
  const accountCard = html`<section class="app-card">
    <div class="app-card-heading">
      ${icon(Github, 20)}
      <h3>Your GitHub account</h3>
      <span class=${`app-status-pill ${c?.identity && status.startsWith("Connected") ? "ready" : ""}`}
        >${c?.identity && status.startsWith("Connected") ? icon(Check, 13) : nothing}${status}</span
      >
    </div>
    ${!c && s.reads.connection ? html`<div class="app-skeleton" aria-hidden="true"></div>` : nothing}
    <p>
      ${c?.identity ? `Verified GitHub username: ${c.identity.login}` : "Use your own GitHub account to submit changes."}
    </p>
    ${error(s.errors.connection ?? (c?.githubAccess === "Invitation pending" ? undefined : c?.error))}${c?.oauthConfigured === false ? html`<p class="hint">Native GitHub authorization is not configured. Ask the instance owner to configure it.</p>` : nothing}
    <div class="actions">
      <button
        class="btn primary"
        ?disabled=${!!s.pending || c?.oauthConfigured === false}
        @click=${() => open("connect")}
      >
        ${accountAction}</button
      ><a class="btn" href=${withBase("/keychain")}>Linked accounts ${icon(ExternalLink, 14)}</a>
    </div>
  </section>`;
  const repoCard = html`<section class="app-card">
    <div class="app-card-heading">
      ${icon(GitBranch, 20)}
      <h3>Repository</h3>
      <span class="app-status-pill">${linked ? "Linked" : repositoryStatus}</span>
    </div>
    ${
      linked
        ? html`<a
              class="app-repository-link"
              href=${`https://github.com/${linked.repository}`}
              target="_blank"
              rel="noreferrer"
              >${linked.repository} ${icon(ExternalLink, 15)}</a
            >
            <p>Base branch <strong>${linked.base}</strong> · App directory <code>${linked.directory || "/"}</code></p>
            <div class="actions">
              ${d.permission === "write" ? html`<button class="btn primary" ?disabled=${!!s.pending || !c?.identity || c.githubAccess !== "Write access ready"} @click=${startSubmit}>Submit a release</button>` : nothing}${c?.canConfigure ? html`<button class="btn" ?disabled=${!!s.pending} @click=${() => open("unlink")}>Unlink</button>` : nothing}
            </div>`
        : html`<p>Publishing to QM works without a GitHub repository.</p>
            ${c?.canConfigure ? html`<button class="btn primary" ?disabled=${!!s.pending || !c.identity} @click=${() => open("setup")}>Connect a repository</button>` : html`<p class="hint">The project or app owner manages the repository connection.</p>`}`
    }
    ${
      tab === "overview"
        ? html`<p class="hint">GitHub account: <strong>${status}</strong></p>
            ${s.reads.connection ? loadingIndicator("Checking GitHub…") : nothing}${error(s.errors.connection)}<button
              class="btn"
              ?disabled=${!!s.reads.connection}
              @click=${refresh}
            >
              Refresh connection
            </button>`
        : nothing
    }
  </section>`;
  if (tab === "overview")
    return html`<div class="app-card-grid">
        <section class="app-card">
          <h3>Live release</h3>
          <strong class="app-metric">${current ? `Version ${current.version}` : "No live release"}</strong>
          <p>${current?.title ?? "Release title unavailable"}</p>
          <p class="hint">${current?.publisher ?? "Unknown publisher"}</p>
        </section>
        ${repoCard}
      </div>
      ${s.pending ? loadingIndicator(s.pending) : nothing}${error(s.error)}`;
  if (tab === "versions")
    return html`<section class="app-card app-release-detail">
      ${
        s.release
          ? html`<div class="app-card-heading">
                <h3>Version ${s.release.version}: ${s.release.title || "Release title unavailable"}</h3>
              </div>
              <p>${s.release.description || "Description unavailable"}</p>
              <p class="hint">
                Publisher: ${s.release.publisher || "Unknown publisher"} ·
                ${new Date(s.release.createdAt).toLocaleString()}
              </p>
              ${sha(s.release.commit || "Unavailable")}${s.release.sourceSha ? sha(s.release.sourceSha, "Imported GitHub SHA") : nothing}
              <p><strong>Commit message</strong><br />${s.release.commitMessage || "Unavailable"}</p>
              <div class="actions">
                ${d.permission === "write" ? html`<button class="btn" ?disabled=${!!s.pending} @click=${() => open("edit", { version: s.release!.version, title: s.release!.title ?? "", description: s.release!.description ?? "" })}>Edit release details</button><button class="btn" ?disabled=${!!s.pending || s.release.version === d.appliedVersion} @click=${() => open("rollback", { version: s.release!.version })}>Restore this version</button>${linked ? html`<button class="btn primary" ?disabled=${!!s.pending || c?.githubAccess !== "Write access ready"} @click=${startSubmit}>Submit to GitHub</button>` : nothing}` : nothing}
              </div>
              <label class="app-field"
                >Compare against<select
                  aria-label="Compare against"
                  .value=${s.comparison}
                  @change=${(e: Event) => void viewRelease(d, s.release!, redraw, (e.target as HTMLSelectElement).value)}
                >
                  <option value="">Parent version</option>
                  ${d.versions?.filter((v) => v.version !== s.release!.version).map((v) => html`<option value=${String(v.version)}>Version ${v.version}</option>`)}
                </select></label
              >${s.reads.release ? loadingIndicator("Loading release comparison…") : nothing}${error(s.errors.release)}${s.errors.release ? html`<button class="btn" @click=${() => void viewRelease(d, s.release!, redraw, s.comparison)}>Retry comparison</button>` : nothing}${diff(s.changes)}${s.events?.map((e) => html`<p class="hint">${e.kind}: ${e.outcome} · ${e.actor} · ${new Date(e.at).toLocaleString()}</p>`)}`
          : html`<p>Select a version to inspect its source and deployment history.</p>`
      }${s.pending ? loadingIndicator(s.pending) : nothing}${error(s.error)}
    </section>`;
  const operationDetails = (o: Operation) => {
    if (o.pr) {
      return html`<div class="app-card-heading">
          <a href=${o.pr.html_url} target="_blank" rel="noreferrer"
            >PR #${o.pr.number}: ${o.pr.merged_at ? "Merged" : o.pr.state}</a
          ><span class="app-status-pill">${o.pr.merged_at ? "Merged" : o.pr.state}</span>
        </div>
        <p>${o.pr.user.login} · ${o.pr.head.ref} → ${o.pr.base.ref}</p>
        <div class="actions">
          <button
            class="btn"
            @click=${() =>
              void s.read(
                "diff",
                (signal) =>
                  request(d, "submission-diff", { submissionId: o.id }, signal) as Promise<{
                    changes: Change[];
                  }>,
                (result) => {
                  s.submittedChanges = result.changes;
                },
                redraw,
              )}
          >
            View outgoing diff</button
          >${
            o.pr.merged_at && d.permission === "write"
              ? html`<button
                  class="btn"
                  ?disabled=${!!s.pending}
                  @click=${() => {
                    s.submissionId = o.id;
                    open("import");
                  }}
                >
                  Import merged version
                </button>`
              : nothing
          }
        </div>`;
    }
    if (o.branch) {
      return html`<strong>Version ${o.release} pushed to ${o.branch}</strong
        >${sha(o.commit ?? "Unavailable", "GitHub commit")}`;
    }
    if (o.invitation) {
      return html`<strong>${o.invitation.username}</strong>
        <p>${o.invitation.removedAt ? "QM-granted access removed" : "Repository invitation sent"}</p>
        ${c?.canConfigure && o.invitation.granted && !o.invitation.removedAt ? html`<button class="btn" ?disabled=${!!s.pending} @click=${() => open("remove-access", { invitationId: o.id })}>Remove QM-granted repository access</button>` : nothing}`;
    }
    return nothing;
  };
  const activity = () => {
    if (!c) {
      return loadingIndicator("Loading repository activity…");
    }
    if (!c.operations.length) {
      return html`<p class="hint">Submitted commits and pull requests will appear here.</p>`;
    }
    return c.operations
      .filter((o) => o.pr || o.branch || o.invitation || o.result === undefined)
      .map(
        (o) =>
          html`<article class="app-activity">
            ${operationDetails(o)}${
              o.input && o.result === undefined && o.actor === c.actorId
                ? html`<p class="hint">Pending ${o.action}. Resume the previously reviewed request.</p>
                    <button
                      class="btn"
                      ?disabled=${!!s.pending}
                      @click=${() =>
                        void s.mutate(
                          "Resuming reviewed action…",
                          async () => {
                            await request(d, o.action!, o.input!);
                            await refreshApp();
                            refresh();
                          },
                          redraw,
                        )}
                    >
                      Resume reviewed action
                    </button>`
                : nothing
            }
          </article>`,
      );
  };
  if (tab === "github")
    return html`<div class="app-section-heading">
        <div>
          <h3>GitHub collaboration</h3>
          <p class="hint">QM publishes immediately. GitHub review controls the repository base branch.</p>
        </div>
        <button class="btn" ?disabled=${!!s.reads.connection} @click=${refresh}>
          ${s.reads.connection ? loadingIndicator("Checking…") : html`${icon(RefreshCw, 14)}Refresh status`}
        </button>
      </div>
      <p class="hint" role="status">
        ${s.lastChecked ? `Last successful check: ${new Date(s.lastChecked).toLocaleTimeString()}` : "Waiting for the first successful check."}
      </p>
      <div class="app-card-grid">${accountCard}${repoCard}</div>
      <section class="app-card">
        <div class="app-card-heading">
          ${icon(ShieldCheck, 20)}
          <h3>Access</h3>
          <span class=${`app-status-pill ${c?.githubAccess === "Write access ready" ? "ready" : ""}`}
            >${c?.githubAccess ?? "Checking access"}</span
          >
        </div>
        <p>QM app access: <strong>${c?.qmAccess ?? (d.permission === "write" ? "manage" : "view")}</strong></p>
        <p class="hint">
          App manage access permits publishing and rollback. Repository write access additionally permits GitHub
          submissions.
        </p>
        ${c?.githubAccess === "Invitation pending" ? html`<a class="btn" href=${`https://github.com/${linked?.repository}/invitations`} target="_blank" rel="noreferrer">Accept invitation in GitHub</a>` : nothing}${linked && c?.canConfigure ? html`<button class="btn" ?disabled=${!!s.pending} @click=${() => open("invite")}>Invite to repository</button>` : nothing}
      </section>
      <section class="app-card">
        <h3>Submissions and activity</h3>
        ${activity()}
      </section>
      ${s.reads.diff ? loadingIndicator("Loading outgoing diff…") : nothing}${error(s.errors.diff)}${diff(s.submittedChanges)}${s.pending ? loadingIndicator(s.pending) : nothing}${error(s.error)}`;
  if (tab !== "dialog" || !s.mode) return nothing;
  const mode = s.mode;
  const needsReview = ["create", "link", "submit", "import", "invite"].includes(mode);
  let valid = mode !== "rollback" || (!s.reads.release && !s.errors.release);
  if (mode === "create")
    valid = /^[a-zA-Z0-9_.-]{1,100}$/.test(String(s.draft.name ?? "")) && !!String(s.draft.message ?? "").trim();
  if (mode === "link") valid = /^[^/\s]+\/[^/\s]+$/.test(String(s.draft.repository ?? "")) && !!s.draft.base;
  if (mode === "submit") valid = !!s.draft.branch && !!String(s.draft.message ?? "").trim();
  if (mode === "invite") valid = !!String(s.draft.principalId ?? "").trim();
  if (mode === "edit") valid = !!String(s.draft.title ?? "").trim();
  let reviewLabel = "Review exact outgoing changes";
  if (mode === "invite") reviewLabel = "Verify GitHub identity";
  if (s.errors.preview) reviewLabel = "Retry review";
  const connectionDetails = () => {
    if (mode === "connect") {
      return html`<p>Connect your personal GitHub account. You’ll return to this app after authorization.</p>
        <p class="app-status-pill">${status}</p>
        <p class="hint">Your account credentials stay in Keychain. QM publishing remains available without GitHub.</p>`;
    }
    return nothing;
  };
  const dialogActions = () => {
    if (mode === "connect") {
      return html`<button
        class="btn primary"
        ?disabled=${!!s.pending || c?.oauthConfigured === false}
        @click=${() =>
          void s.mutate(
            "Opening GitHub authorization",
            async () => {
              const result = await api<{ authorizeUrl: string }>("/api/connectors/github/start", {
                method: "POST",
                body: JSON.stringify({ returnTo: `/apps/${encodeURIComponent(d.id)}?tab=github` }),
              });
              window.location.assign(result.authorizeUrl);
            },
            redraw,
          )}
      >
        ${s.pending ? loadingIndicator("Opening GitHub…") : "Continue to GitHub"}
      </button>`;
    }
    if (mode !== "setup") {
      if (needsReview && !s.preview) {
        return html`<button
          class="btn primary"
          ?disabled=${!!s.pending || !!s.reads.preview || !valid}
          @click=${preview}
        >
          ${s.reads.preview ? loadingIndicator("Loading review…") : reviewLabel}
        </button>`;
      }
      return html`${mode === "submit" ? html`<button class="btn" ?disabled=${!!s.pending || !valid} @click=${() => execute({ createPr: false })}>Push commits</button>` : nothing}<button
          class="btn primary"
          ?disabled=${!!s.pending || !valid || (mode === "link" && !!s.preview?.changes.length && !s.draft.choice)}
          @click=${() => execute()}
        >
          ${s.pending ? loadingIndicator("Working…") : labels[mode]}
        </button>`;
    }
    return nothing;
  };
  return html`<dialog
    class="app-workflow-dialog"
    aria-labelledby="app-workflow-title"
    ${ref((el) => {
      if (el instanceof HTMLDialogElement)
        queueMicrotask(() => {
          if (el.isConnected && !el.open) el.showModal();
        });
    })}
    @cancel=${(e: Event) => {
      e.preventDefault();
      close();
    }}
    @click=${(e: MouseEvent) => {
      if (e.target === e.currentTarget) {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
      }
    }}
  >
    <header>
      <div>
        <p class="app-eyebrow">${icon(Github, 16)}QM · GitHub</p>
        <h2 id="app-workflow-title">${titles[mode]}</h2>
      </div>
      <button class="btn" aria-label="Close dialog" ?disabled=${!!s.pending} @click=${close}>${icon(X, 18)}</button>
    </header>
    <div class="app-dialog-body">
      ${
        needsReview
          ? html`<ol class="app-workflow-steps">
              <li class=${s.preview ? "complete" : "active"}>1 · Configure</li>
              <li class=${s.preview ? "active" : ""}>2 · Review</li>
              <li>3 · Confirm</li>
            </ol>`
          : nothing
      }${connectionDetails()}${
        mode === "setup"
          ? html`<p>Choose how to synchronize this app. QM publishing works independently.</p>
              <div class="app-setup-options">
                <button
                  class="app-option"
                  @click=${() => {
                    s.start("create", {
                      name: d.name || "qm-app",
                      version: selected?.version ?? d.currentVersion,
                      message: selected?.commitMessage ?? selected?.title ?? "Publish QM app",
                    });
                    redraw();
                  }}
                >
                  <strong>Create private repository</strong
                  ><span
                    >Initialize a repository in your personal GitHub account from the selected release.</span
                  ></button
                ><button
                  class="app-option"
                  @click=${() => {
                    s.start("link", {
                      repository: "",
                      base: "main",
                      directory: "",
                      version: selected?.version ?? d.currentVersion,
                    });
                    redraw();
                  }}
                >
                  <strong>Link existing repository</strong
                  ><span>Compare source and choose import or feature-branch export.</span>
                </button>
              </div>`
          : nothing
      }${
        mode === "create"
          ? html`<p>
                Account: <strong>${c?.identity?.login}</strong> · Privacy: <strong>Private</strong> · Release:
                <strong>v${s.draft.version}</strong>
              </p>
              ${field("name", "Repository name")}${field("message", "Initial commit message", true)}`
          : nothing
      }${
        mode === "link"
          ? html`${field("repository", "Repository (owner/name)")}${field("base", "Base branch")}${field("directory", "App directory (blank for root)")}<label
                class="app-field"
                >When contents differ<select
                  aria-label="When contents differ"
                  .value=${String(s.draft.choice ?? "")}
                  ?disabled=${!!s.pending}
                  @change=${(e: Event) => change("choice", (e.target as HTMLSelectElement).value)}
                >
                  <option value="">Choose after reviewing the comparison…</option>
                  <option value="export">Export QM through a feature branch</option>
                  <option value="import">Import GitHub into a new live QM release</option>
                </select></label
              >
              <p class="hint">The existing base branch is never overwritten during linking.</p>`
          : nothing
      }${
        mode === "submit"
          ? html`<p>
                Selected release: <strong>v${s.draft.version}</strong> · Base branch: <strong>${linked?.base}</strong>
              </p>
              <label class="app-field"
                >Branch destination<select
                  aria-label="Branch destination"
                  .value=${s.draft.existingBranch ? "existing" : "new"}
                  ?disabled=${!!s.pending}
                  @change=${(e: Event) => change("existingBranch", (e.target as HTMLSelectElement).value === "existing")}
                >
                  <option value="new">New feature branch</option>
                  <option value="existing">Existing feature branch</option>
                </select></label
              >${field("branch", "Feature branch")}${field("message", "Commit message", true)}${field("title", "PR title")}${field("description", "PR description", true)}`
          : nothing
      }${
        mode === "invite"
          ? html`<p>
                The contributor must connect their own GitHub account first. We verify their username before you send an
                invitation.
              </p>
              ${field("principalId", "Contributor’s QM user ID or email")}`
          : nothing
      }${
        mode === "rollback"
          ? html`<p>
                Restore <strong>version ${s.draft.version}</strong> over live
                <strong>version ${d.appliedVersion ?? "none"}</strong>?
              </p>
              <p>
                Stored code and release configuration will be redeployed. Newer releases, persistent data, and GitHub
                branches remain preserved.
              </p>
              ${s.reads.release ? loadingIndicator("Loading change summary…") : diff(s.changes)}${error(s.errors.release)}${s.errors.release ? html`<button class="btn" @click=${() => s.release && void viewRelease(d, s.release, redraw, String(d.appliedVersion))}>Retry change summary</button>` : nothing}`
          : nothing
      }${
        mode === "edit"
          ? html`${field("title", "Release title")}${field("description", "Release description", true)}
              <p class="hint">Existing commit messages and SHAs remain immutable.</p>`
          : nothing
      }${
        mode === "unlink"
          ? html`<p>Stop synchronizing with <strong>${linked?.repository}</strong>?</p>
              <p>QM releases, audit history, and the GitHub repository remain preserved.</p>`
          : nothing
      }${mode === "remove-access" ? html`<p>Cancel the pending invitation or remove the direct repository access originally granted through QM. Unrelated GitHub memberships remain unchanged.</p>` : nothing}${
        s.preview
          ? html`<section class="app-review">
              <h3>${mode === "invite" ? "Verified contributor" : "Review exact changes"}</h3>
              ${s.preview.identity ? html`<p>Invite <strong>${s.preview.identity.login}</strong> to <strong>${linked?.repository}</strong> with write access.</p>` : html`${diff(s.preview.changes)}${sha(s.preview.expectedSha, "GitHub SHA")}`}${s.preview.otherPublishers?.length ? html`<div class="app-feedback">This release includes changes by ${s.preview.otherPublishers.join(", ")}.</div>` : nothing}${s.preview.replacesNewerChanges ? html`<div class="app-feedback warning">QM has newer changes. Import replaces the selected source with the merged GitHub source.</div>` : nothing}
            </section>`
          : nothing
      }${error(s.errors.preview)}${error(s.error)}${s.pending ? loadingIndicator(`${s.pending}… Keep this request open while it completes.`) : nothing}
    </div>
    <footer>
      <button class="btn" ?disabled=${!!s.pending} @click=${close}>
        ${mode === "setup" ? "Skip for now" : "Cancel"}</button
      >${dialogActions()}
    </footer>
  </dialog>`;
}
