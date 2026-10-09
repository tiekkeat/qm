import { html, nothing, render } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { errMessage } from "../../chassis/src/errors.ts";
import { restoreDialogFocus, trapDialogFocus } from "./dialog-focus.ts";

export interface McpSelectableTool {
  remoteName: string;
  description: string;
  approved: boolean;
  readOnly: boolean;
}

export function openMcpToolsDialog(options: {
  tools: McpSelectableTool[];
  mode: "permissions" | "share" | "view";
  onSave?: (tools: McpSelectableTool[]) => Promise<void> | void;
}): void {
  const opener = document.activeElement as HTMLElement | null;
  const dialog = document.createElement("dialog");
  dialog.className = "mcp-dialog mcp-tool-dialog";
  dialog.setAttribute("aria-labelledby", "mcp-tool-dialog-title");
  document.body.append(dialog);
  const tools = options.tools.map((tool) => ({ ...tool }));
  const editable = options.mode !== "view";
  const labels = {
    permissions: {
      title: "Tool permissions",
      hint: "Enable the tools QM may use. Mark read-only only after checking their behavior.",
      save: "Save permissions",
    },
    share: {
      title: "Permitted tools",
      hint: "Choose the approved tools this recipient may use.",
      save: "Apply selection",
    },
    view: { title: "Available tools", hint: "Tools available through this connection.", save: "" },
  }[options.mode];
  let search = "";
  let page = 0;
  let busy = false;
  let error = "";
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    render(nothing, dialog);
    dialog.remove();
    restoreDialogFocus(opener, () => document.querySelector<HTMLElement>(".mcp-content button"));
  };
  const close = () => {
    if (busy) return;
    dialog.close();
    cleanup();
  };
  dialog.addEventListener("close", cleanup);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    close();
  });
  dialog.addEventListener("keydown", (event) => trapDialogFocus(event, close));
  function checkbox(tool: McpSelectableTool, field: "approved" | "readOnly", label: string) {
    return html`<label
      ><input
        type="checkbox"
        .checked=${tool[field]}
        ?disabled=${busy}
        @change=${(event: Event) => {
          tool[field] = (event.target as HTMLInputElement).checked;
          draw();
        }}
      />${label}</label
    >`;
  }
  function toolRow(tool: McpSelectableTool) {
    return html`<li class="mcp-picker-tool">
      <div class="mcp-picker-description">
        <strong>${tool.remoteName}</strong>
        <p>${tool.description || "No description provided."}</p>
      </div>
      <div class="mcp-picker-controls">
        ${editable ? checkbox(tool, "approved", options.mode === "permissions" ? "Enabled" : "Permitted") : nothing}
        ${options.mode === "permissions" ? checkbox(tool, "readOnly", "Read-only") : html`<span class="mcp-tool-badge">${tool.readOnly ? "Read-only" : "Write capable"}</span>`}
      </div>
    </li>`;
  }
  function draw() {
    const matches = tools.filter((tool) =>
      `${tool.remoteName} ${tool.description}`.toLowerCase().includes(search.trim().toLowerCase()),
    );
    const pages = Math.max(1, Math.ceil(matches.length / 20));
    page = Math.min(page, pages - 1);
    const bulk = (field: "approved" | "readOnly", value: boolean) => {
      for (const tool of matches) tool[field] = value;
      draw();
    };
    render(
      html` <header class="mcp-dialog-head">
          <div>
            <h2 id="mcp-tool-dialog-title">${labels.title}</h2>
            <p class="mcp-hint">${labels.hint}</p>
          </div>
          <button type="button" aria-label="Close tool dialog" ?disabled=${busy} @click=${close}>×</button>
        </header>
        <div class="mcp-dialog-toolbar">
          <label
            >Search tools<input
              type="search"
              .value=${search}
              ?disabled=${busy}
              @input=${(event: Event) => {
                search = (event.target as HTMLInputElement).value;
                page = 0;
                draw();
              }}
          /></label>
          <p role="status">
            ${tools.filter((tool) => tool.approved).length} selected · ${matches.length} matches · ${tools.length} total
          </p>
          ${
            editable
              ? html`<div class="mcp-dialog-bulk">
                    <button type="button" ?disabled=${busy || !matches.length} @click=${() => bulk("approved", true)}>
                      Select all
                    </button>
                    <button type="button" ?disabled=${busy || !matches.length} @click=${() => bulk("approved", false)}>
                      Deselect all
                    </button>
                    ${options.mode === "permissions" ? html`<button type="button" ?disabled=${busy || !matches.length} @click=${() => bulk("readOnly", true)}>Mark read-only</button><button type="button" ?disabled=${busy || !matches.length} @click=${() => bulk("readOnly", false)}>Allow writes</button>` : nothing}
                  </div>
                  <p class="mcp-hint">
                    Bulk actions apply to
                    ${search.trim() ? "all search matches across every page" : "all tools across every page"}.
                  </p>`
              : nothing
          }
        </div>
        <div class="mcp-dialog-list">
          ${
            matches.length
              ? html`<ul>
                  ${repeat(matches.slice(page * 20, page * 20 + 20), (tool) => tool.remoteName, toolRow)}
                </ul>`
              : html`<p class="mcp-picker-empty">
                  ${tools.length ? "No tools match your search." : "No tools available."}
                </p>`
          }
        </div>
        <footer class="mcp-dialog-footer">
          <nav aria-label="Tool pages">
            <button
              type="button"
              ?disabled=${busy || page === 0}
              @click=${() => {
                page--;
                draw();
              }}
            >
              Previous</button
            ><span>Page ${page + 1} of ${pages}</span
            ><button
              type="button"
              ?disabled=${busy || page + 1 === pages}
              @click=${() => {
                page++;
                draw();
              }}
            >
              Next
            </button>
          </nav>
          ${error ? html`<p class="mcp-dialog-error" role="alert">${error}</p>` : nothing}
          <div class="mcp-dialog-actions">
            <button type="button" ?disabled=${busy} @click=${close}>${editable ? "Cancel" : "Close"}</button>
            ${
              editable
                ? html`<button
                    type="button"
                    class="mcp-primary"
                    ?disabled=${busy}
                    @click=${async () => {
                      busy = true;
                      error = "";
                      draw();
                      try {
                        await options.onSave?.(tools);
                        busy = false;
                        close();
                      } catch (failure) {
                        error = errMessage(failure);
                        busy = false;
                        draw();
                      }
                    }}
                  >
                    ${busy ? "Saving…" : labels.save}
                  </button>`
                : nothing
            }
          </div>
        </footer>`,
      dialog,
    );
  }
  draw();
  dialog.showModal();
  dialog.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
}
