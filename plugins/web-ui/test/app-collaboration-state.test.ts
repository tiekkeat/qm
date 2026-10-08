import { test } from "node:test";
import assert from "node:assert/strict";
import { CollaborationState, connectionLabel } from "../src/app-collaboration-state.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
test("a slow GitHub check does not block release comparisons or mutation controls", async () => {
  const s = new CollaborationState();
  const connection = deferred<string>();
  const checked = s.read(
    "connection",
    () => connection.promise,
    () => {},
    () => {},
  );
  let release = "";
  await s.read(
    "release",
    async () => "version 2",
    (value) => {
      release = value;
    },
    () => {},
  );
  assert.equal(release, "version 2");
  assert.equal(s.pending, undefined);
  assert.ok(s.reads.connection);
  connection.resolve("connected");
  await checked;
});
test("superseded release requests cannot replace the selected comparison", async () => {
  const s = new CollaborationState(),
    old = deferred<string>();
  let selected = "";
  const first = s.read(
    "release",
    () => old.promise,
    (value) => {
      selected = value;
    },
    () => {},
  );
  await s.read(
    "release",
    async () => "new",
    (value) => {
      selected = value;
    },
    () => {},
  );
  old.resolve("old");
  await first;
  assert.equal(selected, "new");
  assert.equal(s.errors.release, undefined);
});
test("navigation cancels reads without reporting an error or changing previous results", async () => {
  const s = new CollaborationState(),
    response = deferred<string>();
  let applied = false,
    signal: AbortSignal | undefined;
  const loading = s.read(
    "connection",
    (current) => {
      signal = current;
      return response.promise;
    },
    () => {
      applied = true;
    },
    () => {},
  );
  s.cancelReads();
  response.resolve("late");
  await loading;
  assert.equal(signal?.aborted, true);
  assert.equal(applied, false);
  assert.deepEqual(s.reads, {});
  assert.deepEqual(s.errors, {});
});
test("a timed out check clears its indicator and allows a successful retry", async () => {
  const s = new CollaborationState(5),
    response = deferred<string>();
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await s.read(
      "connection",
      () => response.promise,
      () => {},
      () => {},
    );
    assert.match(s.errors.connection!, /too long/);
    assert.equal(s.reads.connection, undefined);
    let applied = false;
    await s.read(
      "connection",
      async () => "ready",
      () => {
        applied = true;
      },
      () => {},
    );
    assert.equal(applied, true);
    assert.equal(s.errors.connection, undefined);
    response.resolve("late");
  } finally {
    clearTimeout(keepAlive);
  }
});
test("edits invalidate reviewed previews and cancel an older in-flight review", async () => {
  const s = new CollaborationState(),
    old = deferred<string>();
  s.start("submit", { branch: "feature/old" });
  s.preview = { changes: [], expectedSha: "sha", expectedVersion: 1 };
  s.actionId = "old-operation";
  const revision = s.revision;
  let applied = false;
  const read = s.read(
    "preview",
    () => old.promise,
    () => {
      applied = true;
    },
    () => {},
  );
  s.change("branch", "feature/new");
  old.resolve("old diff");
  await read;
  assert.equal(s.preview, undefined);
  assert.equal(s.actionId, undefined);
  assert.equal(s.draft.branch, "feature/new");
  assert.ok(s.revision > revision);
  assert.equal(applied, false);
});
test("mutations prevent duplicate writes but leave reads available and preserve retry IDs", async () => {
  const s = new CollaborationState(),
    done = deferred<void>();
  s.actionId = "durable-operation";
  s.start("rollback", { version: 1 });
  s.actionId = "durable-operation";
  const first = s.mutate(
    "Restoring",
    () => done.promise,
    () => {},
  );
  let duplicate = false;
  assert.equal(
    await s.mutate(
      "Again",
      async () => {
        duplicate = true;
      },
      () => {},
    ),
    false,
  );
  s.change("version", 2);
  assert.equal(s.draft.version, 1);
  await s.read(
    "release",
    async () => "other version",
    () => {},
    () => {},
  );
  done.resolve();
  assert.equal(await first, true);
  assert.equal(duplicate, false);
  assert.equal(
    await s.mutate(
      "Retry",
      async () => {
        throw new Error("network failed");
      },
      () => {},
    ),
    false,
  );
  assert.equal(s.pending, undefined);
  assert.equal(s.actionId, "durable-operation");
  assert.equal(s.error, "network failed");
});

test("connection status distinguishes failed checks, disconnection, revoked authorization, and pending invitations", () => {
  const s = new CollaborationState();
  assert.equal(connectionLabel(s), "Checking connection");
  s.errors.connection = "Timed out";
  assert.equal(connectionLabel(s), "Check failed");
  s.errors = {};
  s.collaboration = {
    canConfigure: true,
    qmAccess: "manage",
    githubAccess: "GitHub not connected",
    operations: [],
    error: "GitHub not connected. Connect in Keychain.",
  };
  assert.equal(connectionLabel(s), "Not connected");
  s.collaboration.error = "fetch failed";
  assert.equal(connectionLabel(s), "Check failed");
  s.collaboration.error = "Authorization revoked. Reconnect in Keychain.";
  assert.equal(connectionLabel(s), "Reconnect required");
  s.collaboration.identity = { login: "contributor" };
  s.collaboration.githubAccess = "Invitation pending";
  s.collaboration.error = "GitHub returned 404";
  assert.equal(connectionLabel(s), "Connected as contributor");
  s.collaboration.error = undefined;
  s.collaboration.githubAccess = "Write access ready";
  assert.equal(connectionLabel(s), "Connected as contributor");
});
