import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><body><button id="opener">Choose tools</button></body>', {
  url: "http://localhost",
});
for (const [key, value] of Object.entries({
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  customElements: dom.window.customElements,
}))
  Object.defineProperty(globalThis, key, { configurable: true, value });
Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", {
  value: function (this: HTMLDialogElement) {
    this.open = true;
  },
});
Object.defineProperty(dom.window.HTMLDialogElement.prototype, "close", {
  value: function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new dom.window.Event("close"));
  },
});
const { openMcpToolsDialog } = await import("../src/mcp-tools-dialog.ts");
const tools = Array.from({ length: 85 }, (_, index) => ({
  remoteName: `opnsense_${index}`,
  description: index < 35 ? "Firewall rule tools" : "Network service tools",
  approved: false,
  readOnly: false,
}));
const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("dialog button")].find(
    (node) => node.textContent?.trim() === label,
  )!;
const search = (value: string) => {
  const input = document.querySelector<HTMLInputElement>('dialog input[type="search"]')!;
  input.value = value;
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("MCP picker bulk edits span matching pages, preserve hidden selections, and save the full catalog", async () => {
  let saved: typeof tools | undefined;
  const opener = document.querySelector<HTMLButtonElement>("#opener")!;
  opener.focus();
  openMcpToolsDialog({
    mode: "permissions",
    tools,
    onSave: (rows) => {
      saved = rows;
    },
  });
  assert.equal(document.querySelectorAll(".mcp-picker-tool").length, 20);
  search("FIREWALL");
  button("Select all").click();
  button("Mark read-only").click();
  assert.match(document.querySelector('dialog [role="status"]')!.textContent!, /35 selected · 35 matches · 85 total/);
  button("Next").click();
  assert.equal(document.querySelectorAll(".mcp-picker-tool").length, 15);
  search("network");
  button("Select all").click();
  button("Allow writes").click();
  search("opnsense_84");
  button("Deselect all").click();
  search("");
  assert.match(document.querySelector('dialog [role="status"]')!.textContent!, /84 selected/);
  button("Save permissions").click();
  await tick();
  assert.equal(saved!.length, 85);
  assert.equal(saved!.filter((tool) => tool.approved).length, 84);
  assert.equal(saved!.filter((tool) => tool.readOnly).length, 35);
  assert.equal(
    tools.some((tool) => tool.approved || tool.readOnly),
    false,
  );
  assert.equal(document.querySelector("dialog"), null);
  assert.equal(document.activeElement, opener);
});

test("MCP picker cancellation discards drafts and failed saves preserve them", async () => {
  let saves = 0;
  openMcpToolsDialog({
    mode: "share",
    tools,
    onSave: () => {
      saves++;
    },
  });
  button("Select all").click();
  button("Cancel").click();
  assert.equal(saves, 0);
  openMcpToolsDialog({
    mode: "share",
    tools,
    onSave: () => {
      throw new Error("Access changed");
    },
  });
  search("missing");
  assert.match(document.querySelector("dialog")!.textContent!, /No tools match your search/);
  assert.equal(button("Select all").disabled, true);
  search("");
  button("Select all").click();
  assert.equal(button("Mark read-only"), undefined);
  button("Apply selection").click();
  await tick();
  assert.match(document.querySelector('dialog [role="alert"]')!.textContent!, /Access changed/);
  assert.match(document.querySelector('dialog [role="status"]')!.textContent!, /85 selected/);
  button("Cancel").click();
});

test("MCP picker Escape cancels and view mode offers no permission mutation", () => {
  openMcpToolsDialog({ mode: "view", tools });
  assert.equal(document.querySelectorAll('dialog input[type="checkbox"]').length, 0);
  assert.equal(button("Select all"), undefined);
  document
    .querySelector("dialog")!
    .dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(document.querySelector("dialog"), null);
});
