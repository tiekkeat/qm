import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createPostgresAccounts } from "../src/auth/accounts.ts";
import { hashPassword, verifyPassword } from "../plugins/chassis/src/password.ts";
const url = process.env.DATABASE_URL;
test(
  "password accounts and login policy persist and tokens are atomic, scoped, and single use",
  { skip: !url },
  async () => {
    const org = randomUUID();
    const a = createPostgresAccounts(url!, org),
      b = createPostgresAccounts(url!, org),
      other = createPostgresAccounts(url!, randomUUID());
    const email = "user@example.test";
    const hash = await hashPassword("first secure password");
    assert.equal(await a.policy(), "both");
    await a.setPolicy("password");
    assert.equal(await b.policy(), "password");
    assert.equal(await other.policy(), "both");
    assert.equal(await a.create(email, hash, true), true);
    assert.equal(await b.create(email, hash, false), false);
    const account = await b.get(email);
    assert.ok(account?.mustChangePassword);
    assert.ok(await verifyPassword("first secure password", account.passwordHash));
    const token = await a.issue({ email, kind: "change", version: account.version });
    assert.equal(await other.ticket(token), null);
    const hash2 = await hashPassword("next secure password");
    const results = await Promise.all([a.complete(token, hash2), b.complete(token, hash2)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await a.ticket(token), null);
    assert.equal((await a.get(email))?.mustChangePassword, false);
    assert.ok(await verifyPassword("next secure password", (await b.get(email))!.passwordHash));
    const reset = await b.issue({ email, kind: "reset", version: 2 });
    assert.equal(await a.complete(reset, null), null);
    await a.replace(email, hash, true);
    assert.equal(await b.complete(reset, hash2), null);
    const pool = new pg.Pool({ connectionString: url });
    try {
      const rows = await pool.query("SELECT token_hash FROM auth_password_tickets WHERE org=$1", [org]);
      assert.ok(rows.rows.every((row) => row.token_hash !== reset));
      await pool.query("UPDATE auth_password_tickets SET expires_at=now()-interval '1 second' WHERE org=$1", [org]);
      assert.equal(await b.ticket(reset), null);
    } finally {
      await pool.end();
    }
  },
);
test("skipped setup cannot be replayed and concurrent setup never overwrites a password", { skip: !url }, async () => {
  const store = createPostgresAccounts(url!, randomUUID());
  const email = "invitee@example.test";
  const skipped = await store.issue({ email, kind: "setup", version: 0 });
  assert.equal((await store.complete(skipped, null))?.version, 0);
  assert.equal(await store.complete(skipped, null), null);
  const token = await store.issue({ email, kind: "setup", version: 0 });
  const second = await store.issue({ email, kind: "setup", version: 0 });
  const hash = await hashPassword("setup secure password");
  const results = await Promise.all([store.complete(token, hash), store.complete(second, hash)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await store.get(email))?.version, 1);
});
