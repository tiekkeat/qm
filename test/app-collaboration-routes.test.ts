import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/api/server.ts";
import type { App } from "../src/api/app.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import { CONTROL_PLANE_AUD, mintCapabilityToken } from "../src/auth/capability-token.ts";
import { scopeId } from "../src/types.ts";

const secret = "collaboration-route-test-secret".repeat(2);
test("release and rollback routes bind verified identity and enforce independent view/manage access", async (t) => {
  const store = createDeployStore();
  const deployment = await store.create({
    ownerScopeId: scopeId("personal", "owner"),
    createdBy: "owner",
    entrypoint: "node app.js",
    snapshotDir: "/tmp",
    title: "First release",
    files: [{ path: "app.js", data: "first" }],
  });
  let rollbackActor: string | undefined;
  const app = {
    authorizesCapabilityScope: async () => true,
    listDeployments: async () => [deployment],
    getDeployment: async () => store.get(deployment.id),
    deploymentGitPermissionFor: async (_id: string, actor: string) => {
      if (actor === "owner") return "write";
      if (actor === "viewer") return "read";
      return null;
    },
    canManageDeployment: async (_id: string, actor: string) => actor === "owner",
    rollbackDeployment: async (_id: string, _version: number, actor: string) => {
      rollbackActor = actor;
    },
  } as unknown as App;
  const server = createServer(app, { signingSecret: secret, deployStore: store });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const request = async (actor: string, method: string, path: string, body?: unknown) =>
    fetch(`${base}/v1/deployments/${deployment.id}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-agent-capability": await mintCapabilityToken(
          { actorId: actor, scopeId: scopeId("personal", actor), aud: CONTROL_PLANE_AUD, exp: Date.now() + 60000 },
          secret,
        ),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  assert.equal((await request("outsider", "GET", "/versions/1")).status, 404);
  assert.equal((await request("viewer", "GET", "/versions/1")).status, 200);
  assert.equal((await request("viewer", "PATCH", "/versions/1", { title: "Edited", description: "" })).status, 403);
  const sha = (await store.versionOf(deployment.id, 1))!.commit;
  assert.equal(
    (
      await request("owner", "PATCH", "/versions/1", {
        title: "Corrected title",
        description: "Corrected description",
        commit: "forged",
      })
    ).status,
    200,
  );
  assert.equal((await store.versionOf(deployment.id, 1))!.commit, sha);
  assert.equal((await request("owner", "GET", "/versions/1?from=999")).status, 400);
  assert.equal((await request("viewer", "POST", "/rollback", { version: 1, principalId: "owner" })).status, 403);
  assert.equal((await request("owner", "POST", "/rollback", { version: 1, principalId: "forged" })).status, 200);
  assert.equal(rollbackActor, "owner");
});
