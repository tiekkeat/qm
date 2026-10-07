import { html, nothing } from "lit";
import { api } from "./core-bridge";
import type { DeploymentView } from "./deploy-view";

type Release = NonNullable<DeploymentView["versions"]>[number];
interface Change {
  path: string;
  sha?: string | null;
  before?: string | null;
  after?: string | null;
}
interface Operation {
  id: string;
  actor: string;
  action?: string;
  input?: Record<string, unknown>;
  result?: unknown;
  branch?: string;
  commit?: string;
  release?: number;
  pr?: {
    html_url: string;
    number: number;
    state: string;
    merged_at: string | null;
    user: { login: string };
    head: { ref: string };
    base: { ref: string };
  };
  invitation?: { username: string; granted: boolean; removedAt?: number };
}
interface Collaboration {
  actorId?: string;
  oauthConfigured?: boolean;
  identity?: { login: string };
  link?: { repository: string; base: string; directory: string; unlinkedAt?: number };
  canConfigure: boolean;
  qmAccess: string;
  githubAccess: string;
  error?: string;
  operations: Operation[];
}
interface State {
  collaboration?: Collaboration;
  error?: string;
  busy: boolean;
  release?: Release;
  changes?: Change[];
  submittedChanges?: Change[];
  events?: Array<{ actor: string; outcome: string; kind: string; at: number }>;
  preview?: {
    changes: Change[];
    expectedSha: string;
    expectedVersion: number;
    otherPublishers?: string[];
    replacesNewerChanges?: boolean;
  };
  mode?: "create" | "link" | "submit" | "import";
  draft: Record<string, unknown>;
  actionId?: string;
  submissionId?: string;
  rollbackId?: string;
}
const confirmLabel = {
  create: "Confirm private repository creation",
  link: "Confirm linking",
  import: "Confirm import and publish",
  submit: "Push and create PR",
};
const modeTitle = {
  create: "Create private repository",
  link: "Link existing repository",
  import: "Import merged version",
  submit: "Submit selected release",
};
const confirmAction = { create: "create", link: "link", import: "import", submit: "submit" };
const previewAction = { create: "create-preview", link: "compare", import: "import-preview", submit: "preview" };
const states = new Map<string, State>();
function state(id: string): State {
  let value = states.get(id);
  if (!value) {
    value = { busy: false, draft: {} };
    states.set(id, value);
  }
  return value;
}
async function run(d: DeploymentView, redraw: () => void, action: () => Promise<void>) {
  const s = state(d.id);
  if (s.busy) return;
  s.busy = true;
  s.error = undefined;
  redraw();
  try {
    await action();
  } catch (error) {
    s.error = error instanceof Error ? error.message : "Action failed.";
  } finally {
    s.busy = false;
    redraw();
  }
}
function request(d: DeploymentView, action: string, input: Record<string, unknown>) {
  return api(`/api/deployments/${encodeURIComponent(d.id)}/collaboration/${action}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
export async function refreshCollaboration(d: DeploymentView, redraw: () => void) {
  await run(d, redraw, async () => {
    state(d.id).collaboration = await api<Collaboration>(`/api/deployments/${encodeURIComponent(d.id)}/collaboration`);
  });
}
export async function viewRelease(d: DeploymentView, release: Release, redraw: () => void, from?: string) {
  await run(d, redraw, async () => {
    const result = await api<{ changes: Change[]; events: State["events"] }>(
      `/api/deployments/${encodeURIComponent(d.id)}/versions/${release.version}${from ? `?from=${encodeURIComponent(from)}` : ""}`,
    );
    const s = state(d.id);
    if (s.release?.version !== release.version) s.rollbackId = undefined;
    s.release = release;
    s.changes = result.changes;
    s.events = result.events;
  });
}
function diff(changes?: Change[]) {
  return changes
    ? html`<div>
        ${
          changes.length
            ? changes.map(
                (c) =>
                  html`<details>
                    <summary>${c.path} ${c.sha === null ? "(deleted)" : ""}</summary>
                    ${
                      c.before !== undefined || c.after !== undefined
                        ? html`<strong>Before</strong>
                            <pre>${c.before ?? "File absent"}</pre>
                            <strong>After</strong>
                            <pre>${c.after ?? "File absent"}</pre>`
                        : html`<code>${c.sha ?? "deleted"}</code>`
                    }
                  </details>`,
              )
            : "No source changes."
        }
      </div>`
    : nothing;
}
export function collaborationPanel(d: DeploymentView, redraw: () => void, refreshApp: () => Promise<void>) {
  const s = state(d.id),
    c = s.collaboration;
  const linked = c?.link && !c.link.unlinkedAt ? c.link : undefined;
  const field = (name: string, label: string, value = "") =>
    html`<label
      >${label}<input
        .value=${String(s.draft[name] ?? value)}
        ?disabled=${s.busy}
        @input=${(event: Event) => {
          s.draft[name] = (event.target as HTMLInputElement).value;
          s.preview = undefined;
          s.actionId = undefined;
        }}
    /></label>`;
  const start = (mode: State["mode"], draft: Record<string, unknown>) => {
    s.mode = mode;
    s.draft = draft;
    s.preview = undefined;
    s.actionId = undefined;
    redraw();
  };
  const execute = (action: string, extra: Record<string, unknown> = {}) =>
    void run(d, redraw, async () => {
      s.actionId ??= crypto.randomUUID();
      const result = (await request(d, action, { ...s.draft, ...extra, operationId: s.actionId, confirmed: true })) as {
        exportRequired?: boolean;
      };
      s.mode = undefined;
      s.preview = undefined;
      s.collaboration = await api<Collaboration>(`/api/deployments/${encodeURIComponent(d.id)}/collaboration`);
      await refreshApp();
      if (action === "link" && result.exportRequired) {
        const release = d.versions?.find((v) => v.version === d.currentVersion);
        start("submit", {
          version: d.currentVersion,
          branch: `qm/v${d.currentVersion}-${Date.now()}`,
          message: release?.commitMessage ?? release?.title ?? "Export QM app",
          title: release?.title ?? "Export QM app",
          description: release?.description ?? "",
          createPr: true,
        });
      }
    });
  const setupControls = c?.canConfigure
    ? html`<div class="actions">
        <button
          class="btn"
          ?disabled=${s.busy}
          @click=${() => start("create", { name: d.name || "qm-app", version: d.currentVersion })}
        >
          Create private repository
        </button>
        <button
          class="btn"
          ?disabled=${s.busy}
          @click=${() => start("link", { repository: "", base: "main", directory: "", version: d.currentVersion })}
        >
          Link existing repository
        </button>
        <button
          class="btn"
          @click=${() => {
            s.mode = undefined;
            redraw();
          }}
        >
          Skip for now
        </button>
      </div>`
    : nothing;
  const operationView = (o: Operation) => {
    if (o.input && o.result === undefined && o.actor === c?.actorId)
      return html`<p>Pending ${o.action} from ${o.actor}. ${o.branch ?? String(o.input.name ?? "")}</p>
        <button
          class="btn"
          ?disabled=${s.busy}
          @click=${() =>
            void run(d, redraw, async () => {
              await request(d, o.action!, o.input!);
              s.collaboration = await api<Collaboration>(`/api/deployments/${encodeURIComponent(d.id)}/collaboration`);
              await refreshApp();
            })}
        >
          Resume reviewed action
        </button>`;

    if (o.pr)
      return html`<button
          class="btn"
          ?disabled=${s.busy}
          @click=${() =>
            void run(d, redraw, async () => {
              const result = (await request(d, "submission-diff", { submissionId: o.id })) as { changes: Change[] };
              s.submittedChanges = result.changes;
            })}
        >
          View outgoing diff</button
        ><a href=${o.pr.html_url} target="_blank" rel="noreferrer"
          >PR #${o.pr.number}: ${o.pr.merged_at ? "Merged" : o.pr.state}</a
        ><span>${o.pr.user.login} · ${o.pr.head.ref} → ${o.pr.base.ref}</span>${
          o.pr.merged_at && d.permission === "write"
            ? html`<button
                class="btn"
                @click=${() => {
                  s.submissionId = o.id;
                  start("import", {});
                }}
              >
                Import merged version
              </button>`
            : nothing
        }`;
    if (o.branch) return html`<span>Version ${o.release} pushed to ${o.branch}</span><code>${o.commit}</code>`;
    if (o.invitation)
      return html`<span
          >GitHub access: ${o.invitation.username} ·
          ${o.invitation.removedAt ? "Removed" : "Invitation sent; accept through GitHub, then refresh access"}</span
        >${
          c?.canConfigure && o.invitation.granted && !o.invitation.removedAt
            ? html`<button
                class="btn"
                @click=${() => {
                  if (
                    window.confirm(
                      `Cancel the pending invitation or remove direct repository access granted through QM for ${o.invitation!.username}?`,
                    )
                  )
                    execute("remove-access", { invitationId: o.id });
                }}
              >
                Remove QM-granted repository access
              </button>`
            : nothing
        }`;
    return nothing;
  };
  return html` ${s.error ? html`<div class="status" role="alert">${s.error}</div>` : nothing}
    ${
      s.release
        ? html`<section class="deploy-detail-section">
            <h3>Version ${s.release.version}: ${s.release.title || "Release title unavailable"}</h3>
            <p>${s.release.description || "Description unavailable"}</p>
            <p>
              Publisher: ${s.release.publisher || "Unknown publisher"} ·
              ${new Date(s.release.createdAt).toLocaleString()}
            </p>
            <p>Source SHA: <code>${s.release.commit || "Unavailable"}</code></p>
            ${s.release.sourceSha ? html`<p>Imported GitHub SHA: <code>${s.release.sourceSha}</code></p>` : nothing}
            ${s.events?.map((event) => html`<p>${event.kind}: ${event.outcome} · ${event.actor} · ${new Date(event.at).toLocaleString()}</p>`)}
            <p>Commit message: ${s.release.commitMessage || "Unavailable"}</p>
            <label
              >Compare against
              <select
                @change=${(event: Event) => void viewRelease(d, s.release!, redraw, (event.target as HTMLSelectElement).value)}
              >
                <option value="">Parent version</option>
                ${d.versions?.filter((v) => v.version !== s.release!.version).map((v) => html`<option value=${String(v.version)}>Version ${v.version}</option>`)}
              </select></label
            >
            ${diff(s.changes)}
            ${
              d.permission === "write"
                ? html`<div class="actions">
                    <button
                      class="btn"
                      ?disabled=${s.busy}
                      @click=${() => {
                        const title = window.prompt("Correct release title", s.release!.title ?? "");
                        if (title === null) return;
                        const description = window.prompt("Correct release description", s.release!.description ?? "");
                        if (description === null) return;
                        void run(d, redraw, async () => {
                          await api(`/api/deployments/${encodeURIComponent(d.id)}/versions/${s.release!.version}`, {
                            method: "PATCH",
                            body: JSON.stringify({ title, description }),
                          });
                          s.release = { ...s.release!, title, description };
                          await refreshApp();
                        });
                      }}
                    >
                      Edit release details
                    </button>
                    <button
                      class="btn"
                      ?disabled=${s.busy || s.release.version === d.appliedVersion}
                      @click=${() => {
                        if (
                          !window.confirm(
                            `Restore version ${s.release!.version}? Current live version: ${d.appliedVersion ?? "none"}. Review the comparison above. Code and release configuration will be restored; persistent data and GitHub branches are preserved.`,
                          )
                        )
                          return;
                        void run(d, redraw, async () => {
                          await api(`/api/deployments/${encodeURIComponent(d.id)}/rollback`, {
                            method: "POST",
                            body: JSON.stringify({
                              version: s.release!.version,
                              operationId: (s.rollbackId ??= crypto.randomUUID()),
                            }),
                          });
                          await refreshApp();
                        });
                      }}
                    >
                      Restore this version
                    </button>
                    ${linked ? html`<button class="btn" ?disabled=${s.busy} @click=${() => start("submit", { version: s.release!.version, branch: `qm/v${s.release!.version}-${Date.now()}`, message: s.release!.commitMessage ?? s.release!.title ?? `Publish version ${s.release!.version}`, title: s.release!.title ?? "", description: s.release!.description ?? "", createPr: true })}>Submit to GitHub</button>` : nothing}
                  </div>`
                : nothing
            }
          </section>`
        : nothing
    }
    <section class="deploy-detail-section">
      <h3>GitHub</h3>
      <p>
        QM publishing works independently. Publishing immediately attempts to update the live app; PR review governs the
        GitHub base branch.
      </p>
      ${
        c
          ? html`${c.oauthConfigured !== undefined ? html`<p>GitHub OAuth client: ${c.oauthConfigured ? "Configured" : "Not configured; ask the instance owner to configure native GitHub authorization"}</p>` : nothing}
              <p>QM app access: ${c.qmAccess} · GitHub: ${c.githubAccess}</p>
              <p>${c.identity ? `Connected as ${c.identity.login}` : "Connect your personal GitHub account."}</p>
              ${c.error ? html`<div class="status">${c.error}</div>` : nothing}`
          : nothing
      }
      <div class="actions">
        <a class="btn" href="/keychain">${c?.identity ? "Reconnect GitHub" : "Connect GitHub"} in Keychain</a
        ><button
          class="btn"
          ?disabled=${s.busy}
          @click=${() =>
            void run(d, redraw, async () => {
              const result = await api<{ authorizeUrl: string }>("/api/connectors/github/start", {
                method: "POST",
                body: JSON.stringify({ returnTo: `/apps/${encodeURIComponent(d.id)}` }),
              });
              window.location.assign(result.authorizeUrl);
            })}
        >
          Authorize GitHub and return to app</button
        ><button class="btn" ?disabled=${s.busy} @click=${() => void refreshCollaboration(d, redraw)}>
          Refresh access and PR status
        </button>
      </div>
      ${
        linked
          ? html`<p>
                <a href=${`https://github.com/${linked.repository}`} target="_blank" rel="noreferrer"
                  >${linked.repository}</a
                >
                · Base ${linked.base} · App directory ${linked.directory || "/"}
              </p>
              ${
                c?.canConfigure
                  ? html`<div class="actions">
                      <button
                        class="btn"
                        ?disabled=${s.busy}
                        @click=${() => {
                          const principalId = window.prompt(
                            "Contributor's QM user ID (they must connect their own GitHub account first)",
                          );
                          if (!principalId) return;
                          void run(d, redraw, async () => {
                            const verified = (await request(d, "contributor-access", { principalId })) as {
                              identity: { login: string; id: number };
                            };
                            if (
                              !window.confirm(
                                `Invite verified GitHub user ${verified.identity.login} to ${linked.repository} with write access?`,
                              )
                            )
                              return;
                            await request(d, "invite", {
                              principalId,
                              expectedGitHubUserId: verified.identity.id,
                              operationId: crypto.randomUUID(),
                              confirmed: true,
                            });
                            s.collaboration = await api<Collaboration>(
                              `/api/deployments/${encodeURIComponent(d.id)}/collaboration`,
                            );
                          });
                        }}
                      >
                        Invite to repository</button
                      ><button
                        class="btn"
                        ?disabled=${s.busy}
                        @click=${() => {
                          if (
                            window.confirm(
                              "Unlink this repository? Synchronization stops; releases, audit history, and the GitHub repository are preserved.",
                            )
                          )
                            execute("unlink");
                        }}
                      >
                        Unlink repository
                      </button>
                    </div>`
                  : nothing
              }`
          : setupControls
      }
      ${
        s.mode
          ? html`<div class="deploy-detail-section">
              <h3>${modeTitle[s.mode!]}</h3>
              ${
                s.mode === "create"
                  ? html`<p>Personal account: ${c?.identity?.login || "Connect GitHub first"} · Privacy: Private</p>
                      ${field("name", "Repository name")}${field("message", "Initial commit message", d.versions?.find((v) => v.version === d.currentVersion)?.commitMessage ?? "")}`
                  : nothing
              }
              ${
                s.mode === "link"
                  ? html`${field("repository", "Repository (owner/name)")}${field("base", "Base branch")}${field("directory", "App directory (blank for root)")}<label
                        >When contents differ<select
                          @change=${(event: Event) => {
                            s.draft.choice = (event.target as HTMLSelectElement).value;
                          }}
                        >
                          <option value="">Choose…</option>
                          <option value="export">Export QM through a feature branch</option>
                          <option value="import">Import GitHub into a new live QM release</option>
                        </select></label
                      >`
                  : nothing
              }
              ${
                s.mode === "submit"
                  ? html`${field("branch", "Feature branch")}${field("message", "Commit message")}${field("title", "PR title")}${field("description", "PR description")}<label
                        ><input
                          type="checkbox"
                          @change=${(event: Event) => {
                            s.draft.existingBranch = (event.target as HTMLInputElement).checked;
                            s.preview = undefined;
                          }}
                        />Use an existing feature branch</label
                      >`
                  : nothing
              }
              ${
                s.preview
                  ? html`${diff(s.preview.changes)}
                      <p>GitHub SHA: <code>${s.preview.expectedSha}</code></p>
                      ${s.preview.otherPublishers?.length ? html`<div class="status">This release includes changes by ${s.preview.otherPublishers.join(", ")}.</div>` : nothing}${s.preview.replacesNewerChanges ? html`<div class="status">QM has newer changes. Import replaces the selected source with the merged GitHub source.</div>` : nothing}<button
                        class="btn primary"
                        ?disabled=${s.busy}
                        @click=${() => execute(confirmAction[s.mode!], { expectedSha: s.preview!.expectedSha, expectedVersion: s.preview!.expectedVersion, submissionId: s.submissionId })}
                      >
                        ${confirmLabel[s.mode!]}</button
                      >${s.mode === "submit" ? html`<button class="btn" ?disabled=${s.busy} @click=${() => execute("submit", { expectedSha: s.preview!.expectedSha, createPr: false })}>Push commits</button>` : nothing}`
                  : html`<button
                      class="btn"
                      ?disabled=${s.busy}
                      @click=${() =>
                        void run(d, redraw, async () => {
                          s.preview = (await request(d, previewAction[s.mode!], {
                            ...s.draft,
                            submissionId: s.submissionId,
                          })) as State["preview"];
                        })}
                    >
                      ${s.mode === "create" ? "Review and create private repository" : "Review exact outgoing changes"}
                    </button>`
              }
              <button
                class="btn"
                ?disabled=${s.busy}
                @click=${() => {
                  s.mode = undefined;
                  redraw();
                }}
              >
                Cancel
              </button>
            </div>`
          : nothing
      }
      ${diff(s.submittedChanges)}
      ${c?.operations.map(
        (o) =>
          html`<div class="deploy-setting-row">
            <div>${operationView(o)}</div>
          </div>`,
      )}
    </section>`;
}
