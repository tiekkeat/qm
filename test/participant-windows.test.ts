import pg from "pg";
import { execFileSync } from "node:child_process";
import { createSessionMethods } from "../src/api/app-sessions.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPostgresSessionStore } from "../src/sessions/postgres-session-store.ts";
import { entryWithinTenure } from "../src/sessions/session-store.ts";
import { scopeId } from "../src/types.ts";
import { testDatabaseUrl } from "./support/test-database.ts";

test("participant removal freezes transcript visibility and rejoining excludes the intervening history", async () => {
  const store = createPostgresSessionStore(testDatabaseUrl());
  const session = await store.getOrCreateByThread(`web:windows:${randomUUID()}`, "dm", scopeId("personal", "owner"));
  const writer = { sessionId: session.id };
  await store.append(writer, { kind: "UserMessage", text: "secret before joining" });
  await store.addParticipant(session.id, "reader");
  const during = await store.append(writer, { kind: "UserMessage", text: "visible membership message" });
  await store.removeParticipant(session.id, "reader");
  await store.append(writer, { kind: "UserMessage", text: "secret after leaving" });
  assert.deepEqual(
    (await store.visibleItems(session.id, "reader")).map((item) => item.seq),
    [during.seq],
  );
  assert.equal(await store.countItemsBefore(session.id, 1000, "reader"), 1);
  assert.equal((await store.lastUserPreviews([session.id], "reader")).get(session.id), "visible membership message");
  assert.deepEqual(
    (await store.searchEntries("reader", "secret")).map((item) => item.seq),
    [],
  );
  const [closed] = await store.participantWindowsOf(session.id);
  assert.ok(closed);
  assert.equal(closed.validToSeq, during.seq + 1);
  assert.equal(entryWithinTenure(during, closed), true);
  await store.addParticipant(session.id, "reader");
  const rejoined = await store.append(writer, { kind: "UserMessage", text: "visible after rejoining" });
  assert.deepEqual(
    (await store.visibleItems(session.id, "reader")).map((item) => item.seq),
    [rejoined.seq],
  );
  const [reopened] = await store.participantWindowsOf(session.id);
  assert.ok(reopened);
  assert.equal(entryWithinTenure(during, reopened), false);
  assert.equal(reopened.validTo, null);
  await store.addParticipant(session.id, "reader", undefined, { includeHistory: true });
  assert.equal((await store.visibleItems(session.id, "reader")).length, 4);
});

test("legacy timestamp bounds remain exclusive at removal and sequence bounds take precedence", () => {
  const window = { validFrom: 100, validTo: 500, validFromSeq: null, validToSeq: null };
  assert.equal(entryWithinTenure({ seq: 2, createdAt: 99 }, window), false);
  assert.equal(entryWithinTenure({ seq: 2, createdAt: 100 }, window), true);
  assert.equal(entryWithinTenure({ seq: 3, createdAt: 500 }, window), false);
  assert.equal(entryWithinTenure({ seq: 2, createdAt: 99 }, { ...window, validFromSeq: 2 }), true);
  assert.equal(entryWithinTenure({ seq: 3, createdAt: 499 }, { ...window, validToSeq: 3 }), false);
});

test("snapshot authorization checks mixed tenure bounds without reading transcript payloads", async () => {
  let allowed = true;
  let window = {
    principalId: "alice",
    validFrom: 100,
    validTo: 500,
    validFromSeq: 2 as number | null,
    validToSeq: null as number | null,
  };
  const methods = createSessionMethods(
    { sessions: { participantWindowsOf: async () => [window] } } as unknown as Parameters<
      typeof createSessionMethods
    >[0],
    {
      sessionForViewer: async () => (allowed ? { scopeId: "personal:alice" } : null),
      principalCanWriteScope: async () => true,
    } as unknown as Parameters<typeof createSessionMethods>[1],
  );
  const bounds = { minSeq: 2, maxSeq: 9, minCreatedAt: 50, maxCreatedAt: 499 };
  assert.equal(await methods.canViewSessionSnapshot("s1", "alice", bounds), true);
  assert.equal(await methods.canViewSessionSnapshot("s1", "bob", bounds), false);
  assert.equal(await methods.canViewSessionSnapshot("s1", "alice", { ...bounds, minSeq: 1 }), false);
  assert.equal(await methods.canViewSessionSnapshot("s1", "alice", { ...bounds, maxCreatedAt: 500 }), false);
  window = { ...window, validFromSeq: null, validToSeq: 10 };
  assert.equal(await methods.canViewSessionSnapshot("s1", "alice", bounds), false);
  assert.equal(await methods.canViewSessionSnapshot("s1", "alice", { ...bounds, minCreatedAt: 100 }), true);
  assert.equal(
    await methods.canViewSessionSnapshot("s1", "alice", { ...bounds, minCreatedAt: 100, maxSeq: 10 }),
    false,
  );
  assert.equal(await methods.canViewSessionSnapshot("s1", "alice", { ...bounds, minSeq: NaN }), false);
  allowed = false;
  assert.equal(await methods.canViewSessionSnapshot("s1", "alice", { ...bounds, minCreatedAt: 100 }), false);
});

test("applying the preserved membership migration keeps former participant records", async () => {
  const databaseUrl = testDatabaseUrl();
  const store = createPostgresSessionStore(databaseUrl);
  const session = await store.getOrCreateByThread(`web:migration:${randomUUID()}`, "dm", scopeId("personal", "owner"));
  await store.addParticipant(session.id, "former");
  await store.append({ sessionId: session.id }, { kind: "UserMessage", text: "retained message" });
  await store.removeParticipant(session.id, "former");
  const expected = await store.participantWindowsOf(session.id);
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await pool.query("DELETE FROM qm_schema_migrations WHERE id = $1", [
      "sessions/store/0055-preserve-participant-windows",
    ]);
    const actual = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { createPostgresSessionStore } from "./src/sessions/postgres-session-store.ts";
      const store = createPostgresSessionStore(process.env.QM_WINDOW_TEST_URL);
      console.log(JSON.stringify(await store.participantWindowsOf(process.env.QM_WINDOW_TEST_SESSION)));
      process.exit(0);
    `,
      ],
      {
        cwd: new URL("../", import.meta.url),
        env: { ...process.env, QM_WINDOW_TEST_URL: databaseUrl, QM_WINDOW_TEST_SESSION: session.id },
        encoding: "utf8",
        timeout: 30000,
      },
    );
    assert.deepEqual(JSON.parse(actual), expected);
    assert.notEqual(expected[0]!.validTo, null);
  } finally {
    await pool.end();
  }
});

test("direct transcript item lookup cannot bypass a reader's membership window", async () => {
  const sessions = createPostgresSessionStore(testDatabaseUrl());
  const session = await sessions.getOrCreateByThread(
    `web:item-access:${randomUUID()}`,
    "dm",
    scopeId("personal", "owner"),
  );
  const writer = { sessionId: session.id };
  const before = await sessions.append(writer, { kind: "UserMessage", text: "before joining" });
  await sessions.addParticipant(session.id, "reader");
  const during = await sessions.append(writer, { kind: "AgentMessage", text: "during membership" });
  await sessions.removeParticipant(session.id, "reader");
  const after = await sessions.append(writer, { kind: "AgentMessage", text: "after leaving" });
  const methods = createSessionMethods(
    { sessions } as Parameters<typeof createSessionMethods>[0],
    { sessionForViewer: async () => session } as unknown as Parameters<typeof createSessionMethods>[1],
  );
  assert.equal(await methods.getSessionItemForViewer(session.id, "reader", before.seq), null);
  assert.equal(await methods.getSessionItemForViewer(session.id, "reader", after.seq), null);
  assert.deepEqual(await methods.getSessionItemForViewer(session.id, "reader", during.seq), { item: during });
});
