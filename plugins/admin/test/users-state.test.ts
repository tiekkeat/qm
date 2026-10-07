import assert from "node:assert/strict";
import test from "node:test";
import { litFixture } from "./lit-fixture.ts";
import { UsersView } from "../ui/users.ts";
function model() {
  const view = Object.create(UsersView.prototype) as UsersView;
  Object.assign(view, {
    pending: new Set(),
    refreshRequest: 0,
    root: { isConnected: true },
    draw: () => {},
    renderShell: () => {},
    data: {},
    email: "first@example.com",
    role: "member",
    inviteOpen: true,
  });
  return view;
}
test("user invitation keeps newer edited fields open when the submitted invitation succeeds", async () => {
  const view = model();
  let resolve!: (value: any) => void;
  view.services = {
    api: async (method: string) => (method === "POST" ? new Promise((r) => (resolve = r)) : { ok: true, data: {} }),
    clearCache: () => {},
    fmtTime: () => "",
    labelRole: () => "",
  };
  const pending = view.invite();
  view.email = "next@example.com";
  resolve({ ok: true, data: { member: { email: "first@example.com" }, emailSent: true } });
  await pending;
  assert.equal(view.inviteOpen, true);
  assert.equal(view.email, "next@example.com");
});
test("overlapping roster refreshes cannot restore an older snapshot", async () => {
  const view = model();
  const pending: Array<(value: any) => void> = [];
  view.services = { api: () => new Promise((r) => pending.push(r)), clearCache: () => {} };
  const first = view.refresh(),
    second = view.refresh();
  pending[1]({ ok: true, data: { value: "latest" } });
  await second;
  pending[0]({ ok: true, data: { value: "older" } });
  await first;
  assert.equal(view.data.value, "latest");
});

test("roster refresh updates shell counts while retaining search focus and invitation drafts", async () => {
  const f = litFixture();
  const bar = f.document.createElement("div");
  bar.id = "shellbar";
  f.document.body.prepend(bar);
  const shells: any[] = [];
  let data = { users: [], grants: [], externalUsers: [] } as any;
  const view = f.ui.users.users(f.root, data, {
    defaultShell(shell: any) {
      shells.push(shell);
      bar.replaceChildren();
      const search = f.document.createElement("div");
      search.className = "shell-search";
      const input = f.document.createElement("input");
      input.value = shell.search.value;
      input.oninput = () => shell.search.onInput(input.value);
      search.append(input);
      bar.append(search);
    },
    api: async (_method: string, path: string) => ({ ok: true, data: path === "/api/users" ? data : { people: [] } }),
    clearCache() {},
    labelRole: String,
  });
  f.root.querySelector<HTMLButtonElement>('[aria-label="Invite teammate"]')!.click();
  const email = f.root.querySelector<HTMLInputElement>("#users-email")!;
  email.value = "draft@example.com";
  email.dispatchEvent(new f.window.Event("input"));
  const search = bar.querySelector("input")!;
  search.value = "admin";
  search.dispatchEvent(new f.window.Event("input"));
  search.focus();
  search.setSelectionRange(2, 4);
  data = { users: [], grants: [{ role: "org_admin" }], externalUsers: [] };
  await view.refresh();
  view.draw();
  assert.equal(shells.at(-1).stats[1][0], 1);
  assert.equal(bar.querySelector("input"), search);
  assert.equal(f.document.activeElement, search);
  assert.equal(search.value, "admin");
  assert.equal(search.selectionStart, 2);
  assert.equal(search.selectionEnd, 4);
  assert.equal(f.root.querySelector("#users-email"), email);
  assert.equal(email.value, "draft@example.com");
  assert.equal(view.inviteOpen, true);
  bar.replaceChildren(f.document.createTextNode("Another view"));
  await view.refresh();
  assert.equal(bar.textContent, "Another view");
  f.dom.window.close();
});

test("invitation feedback preserves a copyable link without prescribing a provider", async () => {
  for (const configured of [false, true]) {
    const view = model();
    view.data = { inviteEmail: { configured } };
    view.services = {
      api: async (method: string) =>
        method === "POST"
          ? {
              ok: true,
              data: {
                member: { email: "first@example.com" },
                emailSent: false,
                emailProblem: configured ? "SMTP authentication failed" : "not configured",
                signInUrl: "https://qm.test/auth/invite#token=abc",
              },
            }
          : { ok: true, data: { inviteEmail: { configured } } },
      clearCache: () => {},
      fmtTime: () => "",
      labelRole: () => "",
    };
    await view.invite();
    assert.equal(view.inviteLink, "https://qm.test/auth/invite#token=abc");
    assert.match(view.inviteWarning, configured ? /email couldn.t be sent/ : /delivery isn.t configured/);
    assert.ok(!view.inviteWarning.includes("RESEND_API_KEY"));
    assert.equal(view.copyLabel, "Copy invite link");
  }
});

test("manual account creation and temporary-password reset clear password drafts after success", async () => {
  const view = model();
  const requests: any[] = [];
  view.services = {
    api: async (method: string, path: string, body?: any) => {
      requests.push({ method, path, body });
      return { ok: true, data: {} };
    },
    clearCache: () => {},
  };
  Object.assign(view, {
    createEmail: "new@example.test",
    createRole: "member",
    createPassword: "temporary secure password",
    createConfirmation: "temporary secure password",
    createOpen: true,
  });
  await view.createUser();
  assert.equal(requests[0].path, "/api/users/create");
  assert.equal(requests[0].body.email, "new@example.test");
  assert.equal(view.createPassword, "");
  assert.equal(view.createConfirmation, "");
  assert.equal(view.createOpen, false);
  Object.assign(view, {
    resetEmail: "new@example.test",
    resetPassword: "replacement temporary password",
    resetConfirmation: "replacement temporary password",
  });
  await view.saveTemporaryPassword();
  assert.ok(requests.some((r) => r.path === "/api/users/password"));
  assert.equal(view.resetPassword, "");
  assert.equal(view.resetEmail, "");
});
test("mismatched password drafts never send an account mutation", async () => {
  const view = model();
  let sent = false;
  view.services = {
    api: async () => {
      sent = true;
      return { ok: true, data: {} };
    },
  };
  Object.assign(view, {
    createRole: "member",
    createEmail: "new@example.test",
    createPassword: "one secure password",
    createConfirmation: "other secure password",
  });
  await view.createUser();
  assert.equal(sent, false);
  assert.match(view.externalMessage, /do not match/);
});
