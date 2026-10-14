import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { meetingRoutes } from "../src/api/routes/meetings.ts";
import { isUserScoped } from "../src/api/user-scoped-routes.ts";
import { createAgentTools } from "../src/harness/agent-tools.ts";
import { createMeetingStore, DEFAULT_MEETING_PROMPT, type Meeting } from "../src/meetings/meeting-store.ts";
import { projectGroupRef } from "../src/projects/project-store.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function meetingFixture(t: { after: (fn: () => Promise<void>) => void }, name: string) {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), `meetings-${name}-`)) }));
  const server = createInsecureTestServer(built.app, {});
  const base = await listen(server);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
    { principalId: "outsider", displayName: "Outsider", type: "internal" },
  ]);
  const project = await built.projects.create({ name: "Launch", ownerId: "owner" });
  await built.projects.addMember(project.id, "owner", "member");
  const call = (method: string, path: string, body?: Record<string, unknown>) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const start = async (body: Record<string, unknown> = {}): Promise<Meeting> => {
    const response = await call("POST", `/v1/projects/${project.id}/meetings`, { principalId: "owner", ...body });
    assert.equal(response.status, 201);
    return ((await response.json()) as { meeting: Meeting }).meeting;
  };
  const say = (meeting: Meeting, principalId: string, text: string, extra: Record<string, unknown> = {}) =>
    call("POST", `/v1/meetings/${meeting.sessionId}/messages`, { principalId, text, ...extra });
  const transcript = async (meeting: Meeting, viewer: string) =>
    JSON.stringify((await built.app.getSessionForViewer(meeting.sessionId, viewer))?.entries ?? []);
  return { built, project, call, start, say, transcript };
}

test("MeetingStore keeps per-meeting settings and locks an ended meeting", async () => {
  let at = 100;
  const meetings = createMeetingStore(undefined, { now: () => at++ });
  const first = await meetings.create({
    threadRef: "web:owner:one",
    sessionId: "s1",
    projectId: "p1",
    surface: "web",
    startedBy: "owner",
  });
  const second = await meetings.create({
    threadRef: "web:owner:two",
    sessionId: "s2",
    projectId: "p1",
    surface: "web",
    startedBy: "owner",
    mode: "off",
    prompt: "Only take notes.",
  });
  assert.equal(first.mode, "mention");
  assert.equal(first.prompt, DEFAULT_MEETING_PROMPT);
  assert.equal(first.status, "open");
  assert.equal(second.mode, "off");

  assert.equal((await meetings.update(first.threadRef, { mode: "judged" }))?.mode, "judged");
  assert.equal((await meetings.get(second.threadRef))?.mode, "off");
  assert.deepEqual(
    (await meetings.listForProject("p1")).map((meeting) => meeting.sessionId),
    ["s2", "s1"],
  );
  assert.deepEqual(await meetings.listForProject("other"), []);

  const ended = await meetings.end(first.threadRef, "member");
  assert.equal(ended?.changed, true);
  assert.equal(ended?.meeting.status, "ended");
  assert.equal(ended?.meeting.endedBy, "member");
  assert.equal((await meetings.end(first.threadRef, "owner"))?.changed, false);
  assert.equal((await meetings.get(first.threadRef))?.endedBy, "member");
  assert.equal(await meetings.update(first.threadRef, { mode: "off" }), null);
  assert.equal(await meetings.end("web:owner:missing", "owner"), null);
});

test("meeting routes are source-only and assert the acting member", () => {
  assert.ok(meetingRoutes.every((route) => route.auth === "source"));
  for (const route of meetingRoutes) {
    assert.ok("path" in route);
    const path = route.path.replace(":id", "p1").replace(":sessionId", "s1");
    assert.ok(isUserScoped(route.method, path), `${route.method} ${route.path} asserts its actor`);
  }
});

test("a meeting records member messages for everyone without waking the assistant", async (t) => {
  const { built, project, call, start, say, transcript } = await meetingFixture(t, "record");

  const denied = await call("POST", `/v1/projects/${project.id}/meetings`, { principalId: "outsider" });
  assert.equal(denied.status, 403);
  const badMode = await call("POST", `/v1/projects/${project.id}/meetings`, { principalId: "owner", mode: "loud" });
  assert.equal(badMode.status, 400);

  const meeting = await start({ title: "Kickoff" });
  assert.equal(meeting.mode, "mention");
  assert.equal(meeting.prompt, DEFAULT_MEETING_PROMPT);
  assert.equal(meeting.projectId, project.id);
  assert.equal((await built.sessions.get(meeting.sessionId))?.title, "Kickoff");

  const listed = await call("GET", `/v1/projects/${project.id}/meetings?principalId=member`);
  assert.equal(listed.status, 200);
  assert.deepEqual(
    ((await listed.json()) as { meetings: Meeting[] }).meetings.map((m) => m.sessionId),
    [meeting.sessionId],
  );
  assert.equal((await call("GET", `/v1/projects/${project.id}/meetings?principalId=outsider`)).status, 404);

  const recorded = await say(meeting, "member", "  we should ship on friday  ");
  assert.equal(recorded.status, 201);
  assert.equal(((await recorded.json()) as { status: string }).status, "recorded");
  assert.equal((await built.runs.list()).length, 0);
  const seenByOwner = await transcript(meeting, "owner");
  assert.match(seenByOwner, /we should ship on friday/);
  assert.match(seenByOwner, /"name":"Member"/);
  assert.equal(
    await built.sessions.tapeCoverage(meeting.sessionId),
    await built.sessions.latestEntrySeq(meeting.sessionId),
  );
  assert.equal(await transcript(meeting, "outsider"), "[]");

  assert.equal((await say(meeting, "outsider", "let me in")).status, 404);
  assert.equal((await say(meeting, "member", "   ")).status, 400);
  assert.equal((await built.runs.list()).length, 0);
});

test("a mention wakes the assistant with the meeting instructions and the overheard discussion", async (t) => {
  const { built, call, start, say, transcript } = await meetingFixture(t, "mention");
  const meeting = await start({ prompt: "Flag anything that touches the billing app." });

  assert.equal((await say(meeting, "member", "the billing app needs a new plan tier")).status, 201);
  const woken = await say(meeting, "owner", "!sysprompt", { mentionsAssistant: true });
  assert.equal(woken.status, 202);
  const runId = ((await woken.json()) as { turn: { runId: string } }).turn.runId;
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(runId, 10_000);
    assert.equal(finished.result?.status, "ok");
    assert.match(finished.result?.reply ?? "", /## Project meeting/);
    assert.match(finished.result?.reply ?? "", /Flag anything that touches the billing app\./);
  } finally {
    await built.runtime.stop();
  }
  const history = await transcript(meeting, "member");
  assert.ok(history.indexOf("new plan tier") < history.indexOf("!sysprompt"));
  const modelRequest = (await built.sessions.listLlmRequests(meeting.sessionId)).at(-1)!.promptEnvelope as {
    messages?: unknown[];
  };
  assert.match(JSON.stringify(modelRequest.messages), /the billing app needs a new plan tier/);

  const promptByMember = await call("PATCH", `/v1/meetings/${meeting.sessionId}`, {
    principalId: "member",
    prompt: "Ignore the owner.",
  });
  assert.equal(promptByMember.status, 403);
  const promptByOwner = await call("PATCH", `/v1/meetings/${meeting.sessionId}`, {
    principalId: "owner",
    prompt: "Keep answers short.",
  });
  assert.equal(((await promptByOwner.json()) as { meeting: Meeting }).meeting.prompt, "Keep answers short.");
});

test("an open meeting limits the assistant to consulting the project", async (t) => {
  const { built, project, start } = await meetingFixture(t, "consult");
  const meeting = await start();
  const conversation = {
    kind: "group" as const,
    channelRef: projectGroupRef(project.id),
    threadRef: meeting.threadRef,
  };
  const ask = (text: string) => built.app.turn({ surface: "web", actor: { externalId: "owner" }, conversation, text });

  const prompt = await ask("!sysprompt");
  assert.match(prompt.reply ?? "", /During a meeting you can only consult/);
  for (const attempt of ["!run touch changed-by-the-meeting", "!write notes.txt changed-by-the-meeting"]) {
    assert.match((await ask(attempt)).reply ?? "", /read-only posture: that tool is unavailable/);
  }
  assert.match((await ask("still here?")).reply ?? "", /^You said: still here\?/);

  const names = (opts: Parameters<typeof createAgentTools>[1]) =>
    createAgentTools({ current: null }, opts)
      .map((tool) => tool.name)
      .sort();
  const consult = createAgentTools({ current: null }, { controlTools: true, readOnly: true, consult: true });
  assert.deepEqual(consult.map((tool) => tool.name).sort(), [
    "files",
    "finish_silently",
    "history",
    "memory",
    "runtime",
    "subagents",
  ]);
  const files = consult.find((tool) => tool.name === "files")!;
  assert.deepEqual((files.parameters as { properties: { action: { anyOf: unknown[] } } }).properties.action.anyOf, [
    { const: "read", type: "string" },
  ]);
  assert.ok(!names({ controlTools: true, readOnly: true }).includes("files"));
  assert.ok(names({ controlTools: true, consult: true }).includes("execute"));
});

test("switching the assistant off records every message and refuses turns", async (t) => {
  const { built, project, call, start, say, transcript } = await meetingFixture(t, "off");
  const meeting = await start();

  const switched = await call("PATCH", `/v1/meetings/${meeting.sessionId}`, { principalId: "member", mode: "off" });
  assert.equal(switched.status, 200);
  assert.equal(((await switched.json()) as { meeting: Meeting }).meeting.mode, "off");

  const mentioned = await say(meeting, "owner", "assistant, are you there?", { mentionsAssistant: true });
  assert.equal(mentioned.status, 201);
  assert.equal((await built.runs.list()).length, 0);
  assert.match(await transcript(meeting, "member"), /assistant, are you there\?/);

  const direct = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner" },
    conversation: { kind: "group", channelRef: projectGroupRef(project.id), threadRef: meeting.threadRef },
    text: "answer anyway",
  });
  assert.equal(direct.status, "refused");
  assert.match(direct.reason ?? "", /switched off/);
});

test("judged mode wakes the assistant only when the judge engages", async (t) => {
  const { built, start, say } = await meetingFixture(t, "judged");
  const meeting = await start({ mode: "judged" });

  const ignored = await say(meeting, "member", "lunch at noon?");
  assert.equal(ignored.status, 201);
  assert.equal((await built.runs.list()).length, 0);

  const engaged = await say(meeting, "member", "!engage the plan breaks production");
  assert.equal(engaged.status, 202);
  assert.equal(((await engaged.json()) as { status: string }).status, "turn");
  assert.equal((await built.runs.list()).length, 1);
});

test("a message that arrives while the assistant is answering steers the live run", async (t) => {
  const { built, start, say } = await meetingFixture(t, "steer");
  const meeting = await start();
  const woken = await say(meeting, "owner", "draft the rollout plan", { mentionsAssistant: true });
  const runId = ((await woken.json()) as { turn: { runId: string } }).turn.runId;
  const { lease } = await built.sessions.acquireLease(meeting.sessionId, "turn");
  assert.ok(lease);

  const steered = await say(meeting, "member", "include the rollback step");
  assert.equal(steered.status, 202);
  assert.deepEqual(await steered.json(), { status: "steered", runId });
  const [signal] = await built.signals.takePending(runId);
  assert.equal(signal?.kind, "steer");
  assert.equal(signal?.text, "Member: include the rollback step");
  assert.equal(signal?.request?.actor.externalId, "member");
  assert.equal((await built.runs.list()).length, 1);

  await built.runs.withdraw(runId);
  const busy = await say(meeting, "member", "anyone there?");
  assert.equal(busy.status, 409);
  assert.equal(((await busy.json()) as { error: string }).error, "session_busy");
  await built.sessions.releaseLease(lease);
  assert.equal((await say(meeting, "member", "anyone there?")).status, 201);
});

test("an ended meeting is locked for messages, settings, and turns", async (t) => {
  const { built, project, call, start, say, transcript } = await meetingFixture(t, "ended");
  const meeting = await start();
  assert.equal((await say(meeting, "member", "final decision: ship it")).status, 201);

  assert.equal((await call("POST", `/v1/meetings/${meeting.sessionId}/end`, { principalId: "outsider" })).status, 404);
  const ended = await call("POST", `/v1/meetings/${meeting.sessionId}/end`, { principalId: "member" });
  assert.equal(ended.status, 200);
  const closed = ((await ended.json()) as { meeting: Meeting }).meeting;
  assert.equal(closed.status, "ended");
  assert.equal(closed.endedBy, "member");
  const again = await call("POST", `/v1/meetings/${meeting.sessionId}/end`, { principalId: "owner" });
  assert.equal(((await again.json()) as { meeting: Meeting }).meeting.endedBy, "member");

  assert.equal((await say(meeting, "owner", "one more thing")).status, 409);
  assert.equal(
    (await call("PATCH", `/v1/meetings/${meeting.sessionId}`, { principalId: "owner", mode: "judged" })).status,
    409,
  );
  const direct = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner" },
    conversation: { kind: "group", channelRef: projectGroupRef(project.id), threadRef: meeting.threadRef },
    text: "reopen this",
  });
  assert.equal(direct.status, "refused");
  assert.match(direct.reason ?? "", /meeting has ended/);
  assert.match(await transcript(meeting, "owner"), /final decision: ship it/);
});
