import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";
import type { CoreContext } from "../src/core-bridge.ts";

test("sandbox controls confirm data loss, respect membership, and discard stale inventory", async () => {
  const dom = new JSDOM('<div id="app"></div>', { url: "http://localhost/projects" });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    Document: dom.window.Document,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    InputEvent: dom.window.InputEvent,
    localStorage: dom.window.localStorage,
    location: dom.window.location,
    requestAnimationFrame: (fn: FrameRequestCallback) => setTimeout(() => fn(0), 0),
    cancelAnimationFrame: clearTimeout,
  }))
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  const personal: CoreContext = {
    scopeId: "personal:owner",
    kind: "personal",
    name: "Personal",
    sessionCount: 0,
    lastActivityAt: null,
  };
  const shared: CoreContext = {
    ...personal,
    kind: "group",
    scopeId: "group:web-project-p1",
    project: {
      id: "p1",
      scopeId: "group:web-project-p1",
      name: "Launch",
      ownerId: "owner",
      memberIds: ["owner", "member"],
      members: [],
    },
  };
  const requests: Record<string, unknown>[] = [];
  const row = {
    id: "box",
    name: "Personal computer",
    backend: "local",
    state: "ready",
    availableActions: ["status", "restart", "retire"],
  };
  let manageable = true;
  let stale: Promise<Response> | null = null;
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") {
      requests.push(JSON.parse(String(init.body)));
      return Response.json({
        sandboxes: [],
        defaultSandboxId: null,
        manageable,
        jobs: [],
        providers: [{ name: "local", actions: ["create"] }],
      });
    }
    if (stale) {
      const pending = stale;
      stale = null;
      return pending;
    }
    return Response.json({
      sandboxes: [row],
      defaultSandboxId: "box",
      manageable,
      jobs: [{ processId: "job", sandboxId: "box", purpose: "Report generation" }],
      providers: [{ name: "local", actions: ["create"] }],
    });
  };
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const module = await vite.ssrLoadModule("/src/sandboxes.ts");
    const { render, nothing } = await import("lit");
    let context = personal;
    const draw = () => render(module.sandboxSection(context, draw), document.querySelector<HTMLElement>("#app")!);
    module.resetSandboxes();
    await module.loadSandboxes(context, draw);
    assert.match(document.body.textContent!, /Create sandbox/);
    let confirmation = "";
    window.confirm = (message) => {
      confirmation = message ?? "";
      return false;
    };
    const button = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent!.trim() === label,
      )!;
    button("Retire").click();
    assert.equal(requests.length, 0);
    assert.match(confirmation, /permanently deletes its disk files/);
    assert.match(confirmation, /Saved Files, memory, registered skills, and chats remain/);
    assert.match(confirmation, /Report generation/);
    window.confirm = () => true;
    button("Retire").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(requests[0], { action: "retire", sandboxId: "box", confirm: true });
    manageable = false;
    context = shared;
    module.resetSandboxes();
    row.availableActions = ["status"];
    await module.loadSandboxes(context, draw);
    assert.equal(
      [...document.querySelectorAll("button")].some((button) => button.textContent!.trim() === "Retire"),
      false,
    );
    assert.equal(document.querySelector(".sandbox-create"), null);
    assert.ok(button("Status"));
    const deferred = Promise.withResolvers<Response>();
    stale = deferred.promise;
    const previous = module.loadSandboxes(personal, draw);
    module.resetSandboxes();
    await module.loadSandboxes(shared, draw);
    deferred.resolve(
      Response.json({
        sandboxes: [{ ...row, name: "Stale personal computer" }],
        defaultSandboxId: null,
        manageable: true,
        jobs: [],
        providers: [],
      }),
    );
    await previous;
    draw();
    assert.doesNotMatch(document.body.textContent!, /Stale personal computer/);
    const archived = { ...shared, project: { ...shared.project!, lifecycle: "archived" as const } };
    assert.equal(
      module.projectDeletionSection(archived, true, draw, () => {}),
      nothing,
    );
  } finally {
    await vite.close();
    dom.window.close();
  }
});
