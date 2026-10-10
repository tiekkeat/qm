import { LitElement, html, nothing, type PropertyValues } from "lit";
import { api } from "./core-bridge";
import type { AgentView, AgentSelection } from "./agent-types";
import { errMessage } from "../../chassis/src/errors";
export class AgentPicker extends LitElement {
  static properties = {
    scopeId: { type: String },
    threadRef: { type: String },
    disabled: { type: Boolean },
    rows: { state: true },
    selection: { state: true },
    error: { state: true },
    loading: { state: true },
  };
  scopeId = "";
  threadRef = "";
  disabled = false;
  rows: AgentView[] = [];
  selection: AgentSelection | null = null;
  error = "";
  loading = true;
  private generation = 0;
  private refreshSelection = (event: Event) => {
    if ((event as CustomEvent<{ threadRef: string }>).detail.threadRef === this.threadRef) void this.load();
  };
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("qm-agent-selection", this.refreshSelection);
  }
  disconnectedCallback() {
    window.removeEventListener("qm-agent-selection", this.refreshSelection);
    super.disconnectedCallback();
  }
  createRenderRoot() {
    return this;
  }
  updated(changed: PropertyValues) {
    if (changed.has("scopeId") || changed.has("threadRef")) void this.load();
  }
  async load() {
    const generation = ++this.generation;
    this.loading = true;
    this.error = "";
    try {
      const query = new URLSearchParams({ scopeId: this.scopeId });
      const binding = new URLSearchParams(query);
      if (this.threadRef) binding.set("threadRef", this.threadRef);
      else binding.set("default", "1");
      const [list, current] = await Promise.all([
        api<{ agents: AgentView[] }>(`/api/agents?${query}`),
        api<{ selection: AgentSelection | null }>(`/api/agents/binding?${binding}`),
      ]);
      if (generation !== this.generation) return;
      this.rows = list.agents.filter(
        (a) => a.available || (current.selection?.test && current.selection.id === a.id && a.canEdit),
      );
      this.selection = current.selection;
    } catch (e) {
      if (generation === this.generation) this.error = errMessage(e);
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }
  async select(id: string) {
    const agent = this.rows.find((a) => a.id === id);
    const selection = agent ? { id: agent.id, version: agent.publishedVersion! } : null;
    const generation = ++this.generation;
    this.loading = true;
    this.error = "";
    try {
      if (!this.threadRef) throw new Error("Open a conversation before selecting an agent.");
      await api("/api/agents/binding", {
        method: "POST",
        body: JSON.stringify({ scopeId: this.scopeId, threadRef: this.threadRef, selection }),
      });
      if (generation === this.generation) this.selection = selection;
    } catch (e) {
      if (generation === this.generation) this.error = errMessage(e);
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }
  render() {
    const selected = this.rows.find((a) => a.id === this.selection?.id);
    return html`<label class="agent-picker"
        >Agent
        <select
          aria-label="Chat agent"
          .value=${this.selection?.id ?? ""}
          ?disabled=${this.disabled || this.loading}
          @change=${(e: Event) => void this.select((e.target as HTMLSelectElement).value)}
        >
          <option value="" .selected=${!this.selection}>Default QM</option>
          ${this.selection && !selected ? html`<option value=${this.selection.id} .selected=${true}>Unavailable agent · v${this.selection.version}</option>` : nothing}
          ${this.rows.map((a) => html`<option value=${a.id} .selected=${a.id === this.selection?.id}>${a.name} · ${a.ownerScopeId} · v${a.id === this.selection?.id ? this.selection.version : a.publishedVersion}</option>`)}
        </select></label
      >${selected && selected.publishedVersion !== null && this.selection?.version !== selected.publishedVersion ? html`<button type="button" class="btn" ?disabled=${this.disabled || this.loading} @click=${() => void this.select(selected.id)}>Update to v${selected.publishedVersion}</button>` : nothing}
      ${this.selection?.test ? html`<span>Draft test · v${this.selection.version}</span>` : nothing}
      ${this.error ? html`<span class="composer-error" role="alert">${this.error}</span>` : nothing}`;
  }
}
customElements.define("qm-agent-picker", AgentPicker);
