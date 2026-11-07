import assert from "node:assert/strict";
import test from "node:test";
import { mountPage } from "./fixture.ts";

test("MCP administration refreshes disable and unblock actions inside Settings", async () => {
  const connection = {
    id: "mc1",
    name: "CRM",
    url: "https://tools.example/mcp",
    ownerScopeId: "personal:alice",
    enabled: true,
    blockedByAdmin: false,
  };
  const paths: string[] = [];
  const page = await mountPage("/settings/mcp", {
    "GET /mcp-connections": () => ({ connections: [{ ...connection }] }),
    "GET /mcp-servers": { servers: [] },
    "GET /mcp-policy": { policy: { allowInsecurePrivateEndpoints: true } },
    "POST /mcp-connections/mc1/disable": () => {
      paths.push("disable");
      connection.enabled = false;
      connection.blockedByAdmin = true;
      return {};
    },
    "POST /mcp-connections/mc1/unblock": () => {
      paths.push("unblock");
      connection.blockedByAdmin = false;
      return {};
    },
  });
  await page.settle();
  const button = (label: string) =>
    [...page.host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label)!;
  button("Disable").click();
  await page.settle();
  assert.ok(button("Unblock"));
  button("Unblock").click();
  await page.settle();
  assert.deepEqual(paths, ["disable", "unblock"]);
  assert.match(page.host.textContent!, /CRM/);
  page.close();
});
