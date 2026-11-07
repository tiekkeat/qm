import { html, nothing } from "lit";
import type { AdminPage } from "./sections.ts";
import { card } from "./shared.ts";

type Act = (work: () => Promise<any>, fallback: string, done?: (result: any) => void) => Promise<void>;

export function passwordAccounts(page: AdminPage, act: Act, redraw: () => void, confirmAdmin: (id: string) => boolean) {
  let email = "";
  let role = "member";
  let password = "";
  let confirmation = "";
  let resetEmail = "";
  let policyDraft: string | null = null;
  let notice = "";
  const clear = () => {
    password = "";
    confirmation = "";
  };
  const input = (id: string, label: string, value: string, change: (next: string) => void, type = "password") =>
    html` <label for=${id}>${label}</label
      ><input
        id=${id}
        type=${type}
        autocomplete=${type === "password" ? "new-password" : "email"}
        required
        minlength=${type === "password" ? "12" : "1"}
        .value=${value}
        @input=${(event: Event) => change((event.target as HTMLInputElement).value)}
      />`;
  const submit = (event: Event) => {
    event.preventDefault();
    if (password !== confirmation) {
      notice = "Passwords do not match.";
      redraw();
      return;
    }
    if (!resetEmail && role === "org_admin" && !confirmAdmin(email.trim())) return;
    const target = resetEmail || email.trim();
    const resetting = Boolean(resetEmail);
    void act(
      () =>
        page.api("POST", resetting ? "/api/users/password" : "/api/users/create", {
          email: target,
          password,
          ...(!resetting ? { role } : {}),
        }),
      resetting ? "Could not reset password." : "Could not create user.",
      () => {
        clear();
        resetEmail = "";
        email = "";
        notice = resetting
          ? "Temporary password saved. Existing sessions are invalidated; the user must replace it at sign-in."
          : `Created ${target}. Share the temporary password privately; they must replace it at first sign-in.`;
      },
    );
  };
  return {
    reset(user: any, data: any, busy: boolean) {
      if (
        !data.passwordAccounts?.enabled ||
        data.passwordAccounts.policy === "email" ||
        !user.principalId?.includes("@") ||
        user.offboarded ||
        user.deactivated
      )
        return nothing;
      return html`<button
        class="btn"
        type="button"
        ?disabled=${busy}
        @click=${() => {
          resetEmail = user.principalId;
          clear();
          notice = "";
          redraw();
        }}
      >
        Reset password
      </button>`;
    },
    controls(data: any, busy: boolean) {
      const accounts = data.passwordAccounts;
      if (!accounts?.enabled) return nothing;
      const policy = accounts.policy ?? "both";
      return html`${card(
          "Sign-in methods",
          "Choose how users sign in to this instance.",
          html` <label for="login-policy">Sign-in methods</label
            ><select
              id="login-policy"
              .value=${policyDraft ?? policy}
              @change=${(event: Event) => {
            policyDraft = (event.target as HTMLSelectElement).value;
            redraw();
          }}
            >
              <option value="both">Email links and password</option>
              <option value="password">Password only</option>
              <option value="email">Email links only</option></select
            ><button
              class="btn"
              type="button"
              ?disabled=${busy || (policyDraft ?? policy) === policy}
              @click=${() => {
            if (
              !window.confirm(
                "Change sign-in methods for everyone? Users must use the newly selected methods at their next sign-in.",
              )
            )
              return;
            void act(
              () => page.api("POST", "/api/users/login-policy", { policy: policyDraft ?? policy }),
              "Could not change sign-in methods.",
              () => {
                policyDraft = null;
                notice = "Sign-in methods updated.";
              },
            );
          }}
            >
              Save sign-in methods
            </button>`,
        )}
        ${
          policy === "email"
            ? nothing
            : card(
                resetEmail ? `Temporary password for ${resetEmail}` : "Create password account",
                "Users must replace temporary passwords at first sign-in.",
                html` <form id="password-account-form" @submit=${submit}>
                  ${
              resetEmail
                ? nothing
                : html`${input("create-email", "Email", email, (value) => (email = value), "email")}
                    <label for="create-role">Role</label
                    ><select
                      id="create-role"
                      .value=${role}
                      @change=${(event: Event) => (role = (event.target as HTMLSelectElement).value)}
                    >
                      <option value="member">Member</option>
                      <option value="org_admin">Admin</option>
                    </select>`
            }
                  ${input("create-password", "Temporary password", password, (value) => (password = value))}
                  ${input("create-confirmation", "Confirm password", confirmation, (value) => (confirmation = value))}
                  <button class="btn primary" ?disabled=${busy}>
                    ${resetEmail ? "Save temporary password" : "Create user"}
                  </button>
                  ${
              resetEmail
                ? html`<button
                    class="btn"
                    type="button"
                    @click=${() => {
                      resetEmail = "";
                      clear();
                      redraw();
                    }}
                  >
                    Cancel
                  </button>`
                : nothing
            }
                </form>`,
              )
        }
        <p role="status">${notice}</p>`;
    },
  };
}
