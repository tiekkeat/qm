import { html } from "lit";
import { mountTemplate } from "./shared.ts";

type ProviderId = "openai" | "anthropic" | "openrouter";
type Status = { provider: ProviderId; configured: boolean; source: "admin" | "environment" | "absent" };
type Reply = { ok: boolean; data?: any };
type Actions = { api: (method: string, path: string, body?: unknown) => Promise<Reply>; refresh: () => Promise<void> };
const labels: Record<ProviderId, string> = { openai: "OpenAI", anthropic: "Anthropic", openrouter: "OpenRouter" };
export class BuiltInProvidersState {
  available = false;
  message = "";
  generation = 0;
  rows = Object.keys(labels).map((provider) => ({
    provider: provider as ProviderId,
    configured: false,
    source: "absent",
    key: "",
    busy: false,
    message: "",
    error: false,
  }));
  render = () => {};
  actions!: Actions;
  async load(scope: string) {
    const generation = ++this.generation;
    this.available = scope.startsWith("org:");
    this.render();
    if (!this.available) return;
    try {
      const result = await this.actions.api("GET", "/api/model-providers?catalog=cached");
      if (generation !== this.generation) return;
      if (!result.ok) throw new Error(result.data?.message || "Could not load provider credentials.");
      for (const row of this.rows) {
        const status = (result.data.providers as Status[]).find((item) => item.provider === row.provider);
        if (status) Object.assign(row, { configured: status.configured, source: status.source });
      }
      this.message = "";
    } catch {
      if (generation === this.generation) this.message = "Could not load provider credentials. Refresh to retry.";
    }
    this.render();
  }
  async save(provider: ProviderId, disable = false) {
    const row = this.rows.find((item) => item.provider === provider)!;
    if (row.busy || !this.available) return;
    const key = row.key.trim();
    if (!disable && !key) {
      row.message = "Enter an API key.";
      row.error = true;
      this.render();
      return;
    }
    row.busy = true;
    row.error = false;
    row.message = disable ? "Disabling…" : "Validating and saving…";
    this.render();
    try {
      const result = await this.actions.api(
        disable ? "DELETE" : "PUT",
        "/api/model-providers/" + provider,
        disable ? undefined : { apiKey: key },
      );
      if (!result.ok) throw new Error(result.data?.message || "Could not save provider credentials.");
      if (row.key.trim() === key) row.key = "";
      row.configured = !disable;
      row.source = "admin";
      row.message = disable
        ? "Disabled, including the environment key."
        : "Key saved. New turns use the updated credential.";
      await this.actions.refresh();
    } catch (error) {
      row.message = error instanceof Error ? error.message : "Could not save provider credentials.";
      row.error = true;
    } finally {
      row.busy = false;
      this.render();
    }
  }
}
export const builtInProviders = new BuiltInProvidersState();
export function configureBuiltInProviders(actions: Actions) {
  builtInProviders.actions = actions;
}
export function loadBuiltInProviders(scope: string) {
  return builtInProviders.load(scope);
}
export function mountBuiltInProviders() {
  builtInProviders.render = mountTemplate(
    'template[data-settings-card="card-built-in-providers"]',
    () =>
      html` <section
        class=${"card sv-models" + (builtInProviders.available ? "" : " hidden")}
        id="card-built-in-providers"
      >
        <div class="head">
          <h2>Built-in providers</h2>
          <p>Manage organization API keys. Saved keys are encrypted and cannot be displayed.</p>
        </div>
        <div class="body">
          <p role="status">${builtInProviders.message}</p>
          ${builtInProviders.rows.map(
            (row) =>
              html`<div class="model-runtime-fields">
                <div>
                  <strong>${labels[row.provider]}</strong>
                  <p>
                    ${row.configured ? "Configured" : "Not configured"} ·
                    ${({ environment: "Environment", admin: "Administrator settings", absent: "No key" } as Record<string, string>)[row.source]}
                  </p>
                </div>
                <div>
                  <label for=${"provider-key-" + row.provider}>${labels[row.provider]} API key</label>
                  <input
                    id=${"provider-key-" + row.provider}
                    type="password"
                    autocomplete="new-password"
                    .value=${row.key}
                    ?disabled=${row.busy}
                    @input=${(event: Event) => {
                      row.key = (event.target as HTMLInputElement).value;
                    }}
                    placeholder=${row.configured ? "Enter a replacement key" : "Enter an API key"}
                  />
                </div>
                <div>
                  <button type="button" ?disabled=${row.busy} @click=${() => builtInProviders.save(row.provider)}>
                    Save key
                  </button>
                  <button
                    type="button"
                    class="danger"
                    ?disabled=${row.busy || !row.configured}
                    @click=${() => {
                      if (
                        confirm(
                          "Disable " +
                            labels[row.provider] +
                            " for API-key-backed turns? This also blocks any environment key.",
                        )
                      )
                        void builtInProviders.save(row.provider, true);
                    }}
                  >
                    Disable
                  </button>
                  <p role="status" class=${row.error ? "status err" : "status"}>${row.message}</p>
                </div>
              </div>`,
          )}
        </div>
      </section>`,
  );
}
