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
  shared = { connected: false, needsReconnect: false, grantees: [] as string[] };
  sharedCode = "";
  sharedUrl = "";
  sharedLoginId = "";
  sharedExpiresAt = 0;
  sharedBusy = false;
  sharedMessage = "";
  grantUser = "";
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
      const [result, shared] = await Promise.all([
        this.actions.api("GET", "/api/model-providers?catalog=cached"),
        this.actions.api("GET", "/api/shared-codex"),
      ]);
      if (generation !== this.generation) return;
      if (!result.ok) throw new Error(result.data?.message || "Could not load provider credentials.");
      if (shared.ok && typeof shared.data?.connected === "boolean") {
        this.shared = {
          connected: shared.data.connected,
          needsReconnect: shared.data.needsReconnect === true,
          grantees: Array.isArray(shared.data.grantees) ? shared.data.grantees : [],
        };
      } else this.sharedMessage = shared.data?.message || "Could not load shared Codex access.";
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
  async startShared() {
    if (this.sharedBusy) return;
    this.sharedBusy = true;
    this.sharedMessage = "Starting device sign-in…";
    this.render();
    try {
      const reply = await this.actions.api("POST", "/api/shared-codex/start");
      if (!reply.ok) throw new Error(reply.data?.message || "Could not start sign-in.");
      this.sharedCode = reply.data.userCode;
      this.sharedUrl = reply.data.verificationUrl;
      this.sharedLoginId = reply.data.deviceAuthId;
      this.sharedExpiresAt = reply.data.expiresAt;
      this.sharedMessage = "Enter the code at the linked OpenAI page, then leave this page open.";
      this.sharedBusy = false;
      this.render();
      void this.pollShared(this.sharedLoginId);
    } catch (error) {
      this.sharedBusy = false;
      this.sharedMessage = error instanceof Error ? error.message : "Could not start sign-in.";
      this.render();
    }
  }
  async pollShared(id: string) {
    while (this.sharedLoginId === id && Date.now() < this.sharedExpiresAt) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      if (this.sharedLoginId !== id) return;
      try {
        const reply = await this.actions.api("POST", "/api/shared-codex/poll", { deviceAuthId: id });
        if (!reply.ok) throw new Error(reply.data?.message || "Sign-in failed.");
        if (reply.data.status === "failed") throw new Error("Sign-in failed. Start again.");
        if (reply.data.status !== "connected") continue;
        this.sharedLoginId = "";
        this.sharedCode = "";
        this.sharedMessage = "Shared Codex account connected.";
        await this.load("org:");
        return;
      } catch (error) {
        this.sharedLoginId = "";
        this.sharedMessage = error instanceof Error ? error.message : "Sign-in failed.";
        this.render();
        return;
      }
    }
    if (this.sharedLoginId === id) {
      this.sharedLoginId = "";
      this.sharedMessage = "Sign-in code expired. Start again.";
      this.render();
    }
  }
  async disconnectShared() {
    if (!confirm("Disconnect the shared Codex account? New turns using it will stop.")) return;
    this.sharedBusy = true;
    this.render();
    const reply = await this.actions.api("DELETE", "/api/shared-codex");
    this.sharedBusy = false;
    if (reply.ok) {
      this.sharedLoginId = "";
      this.sharedCode = "";
    }
    this.sharedMessage = reply.ok ? "Shared Codex account disconnected." : reply.data?.message || "Disconnect failed.";
    await this.load("org:");
  }
  async setGrant(userId: string, enabled: boolean) {
    const id = userId.trim();
    if (!id) return;
    this.sharedBusy = true;
    this.render();
    const reply = await this.actions.api(
      enabled ? "PUT" : "DELETE",
      "/api/shared-codex/grants/" + encodeURIComponent(id),
    );
    this.sharedBusy = false;
    this.sharedMessage = reply.ok
      ? `${enabled ? "Access granted" : "Access revoked"}.`
      : reply.data?.message || "Grant update failed.";
    if (reply.ok) this.grantUser = "";
    await this.load("org:");
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
    () => {
      let sharedLabel = "Not connected";
      if (builtInProviders.shared.connected) sharedLabel = "Connected";
      if (builtInProviders.shared.needsReconnect) sharedLabel = "Reconnect required";
      return html` <section
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
          <div class="model-runtime-fields">
            <div>
              <strong>Shared ChatGPT / Codex</strong>
              <p>${sharedLabel}</p>
              <p>Grant access to selected users. Their chats and scheduled turns can use this connection when they choose it.</p>
            </div>
            <div>
              <button type="button" ?disabled=${builtInProviders.sharedBusy} @click=${() => void builtInProviders.startShared()}>
                ${builtInProviders.shared.connected ? "Reconnect" : "Connect with device code"}
              </button>
              ${builtInProviders.sharedCode ? html`<p>Code: <strong>${builtInProviders.sharedCode}</strong></p>
                <a href=${builtInProviders.sharedUrl} target="_blank" rel="noopener noreferrer">Open ChatGPT sign-in</a>` : null}
              <button type="button" class="danger" ?disabled=${builtInProviders.sharedBusy || !builtInProviders.shared.connected}
                @click=${() => void builtInProviders.disconnectShared()}>Disconnect</button>
              <p role="status">${builtInProviders.sharedMessage}</p>
            </div>
            <div>
              <label for="shared-codex-user">Grant user by email or principal ID</label>
              <input id="shared-codex-user" .value=${builtInProviders.grantUser}
                @input=${(event: Event) => { builtInProviders.grantUser = (event.target as HTMLInputElement).value; }} />
              <button type="button" ?disabled=${builtInProviders.sharedBusy || !builtInProviders.shared.connected}
                @click=${() => void builtInProviders.setGrant(builtInProviders.grantUser, true)}>Grant access</button>
              ${builtInProviders.shared.grantees.map((id) => html`<p>${id}
                <button type="button" ?disabled=${builtInProviders.sharedBusy}
                  @click=${() => void builtInProviders.setGrant(id, false)}>Revoke</button></p>`)}
            </div>
          </div>
        </div>
      </section>`;
    },
  );
}
