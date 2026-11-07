import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresRunStore } from "../src/runs/postgres-run-store.ts";
import type { OrchestratorInput } from "../src/core/orchestrator.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
const database = testDatabaseUrl();
for (const backend of ["postgres"]) {
  test(
    `${backend}: agent deletion withdraws only unstarted matching queued turns`,
    { skip: backend === "postgres" && !database },
    async () => {
      const runs = createPostgresRunStore(database).runs;
      const actor = { id: "owner", type: "internal" as const };
      const agentId = randomUUID();
      const sessionId = randomUUID();
      const request: OrchestratorInput = {
        actor,
        conversation: { kind: "dm", threadRef: sessionId, audience: [actor] },
        origin: { kind: "direct" },
        text: "Inspect",
        customAgent: { id: agentId, version: 1 },
      };
      try {
        const active = (await runs.enqueue({ sessionId, request })).run;
        await runs.claimById(active.id, "qa", 60_000);
        const pending = (await runs.enqueue({ sessionId, request })).run;
        const other = (
          await runs.enqueue({
            sessionId: randomUUID(),
            request: { ...request, customAgent: { id: randomUUID(), version: 1 } },
          })
        ).run;
        assert.equal(await runs.withdrawAgent!(agentId), 1);
        assert.equal(await runs.get(pending.id), null);
        assert.ok(await runs.get(active.id));
        assert.ok(await runs.get(other.id));
        assert.equal(await runs.withdrawAgent!(agentId), 0);
      } finally {
        await runs.close?.();
      }
    },
  );
}
