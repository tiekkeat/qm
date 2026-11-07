import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { buildApp } from "../src/wiring.ts";
import { migrateRegisteredPgSchemas } from "../src/persistence/pg-pool.ts";
import { testDatabaseUrl } from "./support/test-database.ts";
import { testConfig } from "./support/test-config.ts";

test("real startup migrations retain native runtime settings and internal-member overrides", async () => {
  const databaseUrl = testDatabaseUrl();
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const scopeId = "org:default-org";
  const saved = {
    approved_harness_configs: { scopeId, ids: ["pi", "claude", "codex", "opencode"] },
    internal_member_overrides: { scopeId, members: ["member@example.com"] },
    base_model_configs: {
      scopeId,
      harnessId: "codex",
      modelId: "gpt-5.6-sol",
      cronRuntime: { harnessId: "claude", modelId: "claude-sonnet-5", effortLevel: "high" },
    },
  };
  for (const [table, row] of Object.entries(saved)) {
    await pool.query(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, json JSONB NOT NULL)`);
    await pool.query(`INSERT INTO ${table} (id, json) VALUES ($1, $2)`, [scopeId, row]);
  }
  const built = buildApp(testConfig({ databaseUrl }));
  try {
    await migrateRegisteredPgSchemas(databaseUrl);
    for (const [table, row] of Object.entries(saved)) {
      assert.deepEqual(
        (await pool.query(`SELECT json FROM ${table} WHERE id = $1`, [scopeId])).rows[0]?.json,
        row,
        table,
      );
    }
    assert.deepEqual(await built.config.getApprovedHarnessesDurable(), saved.approved_harness_configs.ids);
    assert.deepEqual(await built.config.getInternalMemberOverridesDurable(), saved.internal_member_overrides.members);
    assert.equal((await built.config.getRuntimeSelectionDurable("org:default-org"))?.harnessId, "codex");
  } finally {
    await built.runtime.stop();
    await pool.end();
  }
});
