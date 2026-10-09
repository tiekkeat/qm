import { html, render, nothing } from "lit";

interface ApiResult {
  ok: boolean;
  data: any;
}
interface Services {
  api: (method: string, path: string, body?: unknown) => Promise<ApiResult>;
  refresh: () => unknown;
}

let loadSequence = 0;

export async function mount(root: HTMLElement, data: any, services: Services) {
  const sequence = ++loadSequence;
  const [legacy, policy] = await Promise.all([
    services.api("GET", "/api/mcp-servers"),
    services.api("GET", "/api/mcp-policy"),
  ]);
  if (sequence !== loadSequence || !root.isConnected || document.body.dataset.subview !== "mcp") return;
  const host = document.createElement("div");
  root.replaceChildren(host);
  let notice = "";
  let busy = false;
  const mutate = async (method: string, path: string, body?: unknown) => {
    busy = true;
    draw();
    try {
      const result = await services.api(method, path, body);
      if (!result.ok) {
        notice = result.data?.message || result.data?.error || "MCP update failed";
        return;
      }
      services.refresh();
    } catch {
      notice = "MCP update failed; try again";
    } finally {
      busy = false;
      draw();
    }
  };
  function draw() {
    if (sequence !== loadSequence || !host.isConnected || document.body.dataset.subview !== "mcp") return;
    render(
      html`
        ${notice ? html`<p role="alert">${notice}</p>` : nothing}
        <section class="card">
          <div class="head"><h2>MCP connections</h2></div>
          <div class="body">
            <p class="hint">Users add and manage connections in Browse → MCP. Admins can disable any connection.</p>
            ${
              (data.connections ?? []).length
                ? html`<div class="tablewrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Home</th>
                          <th>Server</th>
                          <th>Status</th>
                          <th>Health</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        ${data.connections.map(
                          (connection: any) =>
                            html`<tr>
                              <td>${connection.name}</td>
                              <td>${connection.ownerScopeId}</td>
                              <td>${connection.url}</td>
                              <td>${connection.enabled ? "Enabled" : "Disabled"}</td>
                              <td>
                                ${connection.lastTest ? `${connection.lastTest.ok ? "Test passed" : "Test failed"} · ${new Date(connection.lastTest.at).toLocaleString()}` : "Untested"}
                              </td>
                              <td>
                                <button
                                  ?disabled=${busy}
                                  @click=${() => void mutate("POST", `/api/mcp-connections/${encodeURIComponent(connection.id)}/${connection.blockedByAdmin ? "unblock" : "disable"}`, {})}
                                >
                                  ${connection.blockedByAdmin ? "Unblock" : "Disable"}
                                </button>
                              </td>
                            </tr>`,
                        )}
                      </tbody>
                    </table>
                  </div>`
                : html`<p>No scoped connections yet.</p>`
            }
          </div>
        </section>
        <section class="card">
          <div class="head"><h2>Endpoint policy</h2></div>
          <div class="body">
            <p class="hint">
              Public HTTPS endpoints are allowed. Approve private endpoints by exact hostname, port, and IP addresses or
              CIDRs.
            </p>
            ${
              policy.ok
                ? html`<form
                      @submit=${(event: Event) => {
                        event.preventDefault();
                        const fields = new FormData(event.currentTarget as HTMLFormElement);
                        const exception = {
                          hostname: String(fields.get("hostname") ?? "").trim(),
                          port: Number(fields.get("port")),
                          addresses: String(fields.get("addresses") ?? "")
                            .split(",")
                            .map((part) => part.trim())
                            .filter(Boolean),
                        };
                        void mutate("PUT", "/api/mcp-policy", {
                          exceptions: [...policy.data.policy.exceptions, exception],
                        });
                      }}
                    >
                      <label>Hostname<input name="hostname" required placeholder="tools.internal.example" /></label>
                      <label>Port<input name="port" type="number" min="1" max="65535" value="443" required /></label>
                      <label
                        >Addresses or CIDRs (comma separated)<input
                          name="addresses"
                          required
                          placeholder="10.0.1.20/32"
                      /></label>
                      <button type="submit" ?disabled=${busy}>Add exception</button>
                    </form>
                    ${policy.data.policy.exceptions.map((entry: any, index: number) => html`<p>${entry.hostname}:${entry.port} → ${entry.addresses.join(", ")} <button ?disabled=${busy} @click=${() => void mutate("PUT", "/api/mcp-policy", { exceptions: policy.data.policy.exceptions.filter((_: any, current: number) => current !== index) })}>Remove</button></p>`)}`
                : html`<p role="alert">Could not load endpoint policy.</p>`
            }
          </div>
        </section>
        <section class="card">
          <div class="head"><h2>Legacy instance-wide</h2></div>
          <div class="body">
            <p class="hint">
              Existing connections retain their previous audience. To narrow access, create a scoped connection in
              Browse → MCP, verify it, then disable the legacy entry.
            </p>
            ${(legacy.data?.servers ?? []).map(
              (server: any) =>
                html`<details>
                  <summary>${server.name} · ${server.enabled ? "Enabled" : "Disabled"}</summary>
                  <form
                    @submit=${(event: Event) => {
                      event.preventDefault();
                      const fields = new FormData(event.currentTarget as HTMLFormElement);
                      void mutate("PUT", `/api/mcp-servers/${server.id}`, {
                        name: fields.get("name"),
                        url: fields.get("url"),
                        auth: server.auth,
                        credentialScope: server.credentialScope,
                        credentialHost: server.credentialHost,
                        credentialAccountType: server.credentialAccountType,
                        enabled: fields.has("enabled"),
                        readOnly: fields.has("readOnly"),
                        validate: fields.has("enabled"),
                      });
                    }}
                  >
                    <label>Name<input name="name" .value=${server.name} required /></label
                    ><label>URL<input name="url" type="url" .value=${server.url} required /></label
                    ><label><input name="enabled" type="checkbox" .checked=${server.enabled} />Enabled</label
                    ><label><input name="readOnly" type="checkbox" .checked=${server.readOnly} />Read-only</label
                    ><button type="submit" ?disabled=${busy}>Save</button
                    ><button
                      type="button"
                      ?disabled=${busy}
                      @click=${() => {
                        if (window.confirm(`Delete ${server.name}?`))
                          void mutate("DELETE", `/api/mcp-servers/${server.id}`);
                      }}
                    >
                      Delete
                    </button>
                  </form>
                </details>`,
            )}
          </div>
        </section>
      `,
      host,
    );
  }
  draw();
}
