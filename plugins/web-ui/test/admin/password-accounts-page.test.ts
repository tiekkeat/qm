import assert from "node:assert/strict";
import test from "node:test";
import { mountPage } from "./fixture.ts";

const button = (root: ParentNode, label: string) =>
  [...root.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label)!;

test("password accounts validate confirmation, create users, and clear temporary secrets", async () => {
  const calls: unknown[] = [];
  const users = {
    users: [],
    grants: [],
    externalUsers: [],
    passwordAccounts: { enabled: true, policy: "both", users: [] },
  };
  const page = await mountPage("/settings/users", {
    "GET /users": users,
    "POST /users/create": ({ body }) => {
      calls.push(body);
      return { ok: true };
    },
  });
  await page.settle();
  const fill = (id: string, value: string) => {
    const input = page.document.getElementById(id) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new page.window.Event("input"));
  };
  const submit = () =>
    page.document
      .getElementById("password-account-form")!
      .dispatchEvent(new page.window.Event("submit", { cancelable: true }));
  fill("create-email", "new@example.com");
  fill("create-password", "TemporaryPassword123!");
  fill("create-confirmation", "different");
  submit();
  await page.settle();
  assert.deepEqual(calls, []);
  assert.match(page.host.textContent!, /Passwords do not match/);
  fill("create-confirmation", "TemporaryPassword123!");
  submit();
  await page.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { email: "new@example.com", password: "TemporaryPassword123!", role: "member" },
  ]);
  assert.equal((page.document.getElementById("create-password") as HTMLInputElement).value, "");
  assert.equal((page.document.getElementById("create-confirmation") as HTMLInputElement).value, "");
  assert.match(page.host.textContent!, /must replace it at first sign-in/);
  page.close();
});

test("sign-in policy requires confirmation, and password resets use the selected user", async () => {
  let accept = false;
  const calls: unknown[] = [];
  const users = {
    users: [{ principalId: "alex@example.com", sessionCount: 0, turnCount: 0 }],
    grants: [],
    externalUsers: [],
    passwordAccounts: { enabled: true, policy: "both", users: [] },
  };
  const page = await mountPage(
    "/settings/users",
    {
      "GET /users": users,
      "POST /users/login-policy": ({ body }) => {
        calls.push(["policy", body]);
        return {};
      },
      "POST /users/password": ({ body }) => {
        calls.push(["reset", body]);
        return {};
      },
    },
    { confirm: () => accept },
  );
  await page.settle();
  const policy = page.document.getElementById("login-policy") as HTMLSelectElement;
  policy.value = "password";
  policy.dispatchEvent(new page.window.Event("change"));
  button(page.host, "Save sign-in methods").click();
  await page.settle();
  assert.deepEqual(calls, []);
  accept = true;
  button(page.host, "Save sign-in methods").click();
  await page.settle();
  button(page.host, "Reset password").click();
  await page.settle();
  for (const id of ["create-password", "create-confirmation"]) {
    const input = page.document.getElementById(id) as HTMLInputElement;
    input.value = "ResetPassword123!";
    input.dispatchEvent(new page.window.Event("input"));
  }
  page.document
    .getElementById("password-account-form")!
    .dispatchEvent(new page.window.Event("submit", { cancelable: true }));
  await page.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    ["policy", { policy: "password" }],
    ["reset", { email: "alex@example.com", password: "ResetPassword123!" }],
  ]);
  assert.match(page.host.textContent!, /Existing sessions are invalidated/);
  assert.equal((page.document.getElementById("create-password") as HTMLInputElement).value, "");
  page.close();
});
