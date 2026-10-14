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
import { meetingOutputsFolder } from "../src/meetings/meeting-outputs.ts";
import { createMeetingStore, DEFAULT_MEETING_PROMPT, type Meeting } from "../src/meetings/meeting-store.ts";
import { transcriptChunks } from "../src/core/orchestrator/turn-helpers.ts";
import { projectGroupRef, projectScopeId } from "../src/projects/project-store.ts";
import type { TurnRequest } from "../src/types.ts";
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
  const say = (meeting: Meeting, principalId: string, text: string, extra: Partial<TurnRequest> = {}) =>
    built.app.turn({
      surface: "web",
      actor: { externalId: principalId },
      conversation: { kind: "group", channelRef: projectGroupRef(project.id), threadRef: meeting.threadRef },
      text,
      async: true,
      ...extra,
    });
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
    (await meetings.list()).map((meeting) => meeting.sessionId),
    ["s1", "s2"],
  );

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

  assert.deepEqual(await say(meeting, "member", "  we should ship on friday  "), {
    status: "silent",
    sessionId: meeting.sessionId,
  });
  assert.equal((await built.runs.list()).length, 0);
  const seenByOwner = await transcript(meeting, "owner");
  assert.match(seenByOwner, /we should ship on friday/);
  assert.match(seenByOwner, /"name":"Member"/);
  assert.equal(
    await built.sessions.tapeCoverage(meeting.sessionId),
    await built.sessions.latestEntrySeq(meeting.sessionId),
  );
  assert.equal(await transcript(meeting, "outsider"), "[]");

  assert.equal((await say(meeting, "owner", "retry me", { idempotencyKey: "k1" })).status, "silent");
  assert.equal((await say(meeting, "owner", "retry me", { idempotencyKey: "k1" })).status, "silent");
  assert.equal((await say(meeting, "member", "retry me", { idempotencyKey: "k1" })).status, "silent");
  assert.equal((await transcript(meeting, "owner")).split("retry me").length - 1, 2);

  assert.equal((await say(meeting, "outsider", "let me in")).status, "refused");
  assert.equal((await say(meeting, "member", "   ")).status, "refused");
  const withFile = await say(meeting, "member", "see attached", {
    attachments: [{ name: "plan.pdf", mimetype: "application/pdf", sizeBytes: 1, blobId: "b1" }],
  });
  assert.match(withFile.reason ?? "", /mention the assistant to share a file/);
  assert.equal((await built.runs.list()).length, 0);
});

test("a mention wakes the assistant with the meeting instructions and the overheard discussion", async (t) => {
  const { built, call, start, say, transcript } = await meetingFixture(t, "mention");
  const meeting = await start({ prompt: "Flag anything that touches the billing app." });

  assert.equal((await say(meeting, "member", "the billing app needs a new plan tier")).status, "silent");
  const woken = await say(meeting, "owner", "!sysprompt", { mentionsAssistant: true });
  assert.equal(woken.status, "queued");
  built.runtime.start();
  try {
    const finished = await built.runs.waitFor(woken.runId!, 10_000);
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
  const { start, say } = await meetingFixture(t, "consult");
  const meeting = await start();
  const ask = (text: string) => say(meeting, "owner", text, { mentionsAssistant: true, async: false });

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

test("switching the assistant off records every message and refuses other turns", async (t) => {
  const { built, call, start, say, transcript } = await meetingFixture(t, "off");
  const meeting = await start();

  const switched = await call("PATCH", `/v1/meetings/${meeting.sessionId}`, { principalId: "member", mode: "off" });
  assert.equal(switched.status, 200);
  assert.equal(((await switched.json()) as { meeting: Meeting }).meeting.mode, "off");

  const mentioned = await say(meeting, "owner", "assistant, are you there?", { mentionsAssistant: true });
  assert.equal(mentioned.status, "silent");
  assert.equal((await built.runs.list()).length, 0);
  assert.match(await transcript(meeting, "member"), /assistant, are you there\?/);

  const automated = await say(meeting, "owner", "scheduled check-in", { triggered: true });
  assert.equal(automated.status, "refused");
  assert.match(automated.reason ?? "", /switched off/);
  assert.doesNotMatch(await transcript(meeting, "member"), /scheduled check-in/);
});

test("judged mode wakes the assistant only when the judge engages", async (t) => {
  const { built, start, say, transcript } = await meetingFixture(t, "judged");
  const meeting = await start({ mode: "judged" });

  assert.equal((await say(meeting, "member", "lunch at noon?")).status, "silent");
  assert.equal((await built.runs.list()).length, 0);

  const engaged = await say(meeting, "member", "!engage the plan breaks production");
  assert.equal(engaged.status, "queued");
  assert.ok(engaged.runId);
  assert.equal((await built.runs.list()).length, 1);
  assert.doesNotMatch(await transcript(meeting, "owner"), /the plan breaks production/);
});

test("a message that arrives while the assistant is answering steers the live run", async (t) => {
  const { built, start, say } = await meetingFixture(t, "steer");
  const meeting = await start();
  const woken = await say(meeting, "owner", "draft the rollout plan", { mentionsAssistant: true });
  const runId = woken.runId!;
  const { lease } = await built.sessions.acquireLease(meeting.sessionId, "turn");
  assert.ok(lease);

  assert.deepEqual(await say(meeting, "member", "include the rollback step"), {
    status: "queued",
    runId,
    steered: true,
    sessionId: meeting.sessionId,
  });
  const [signal] = await built.signals.takePending(runId);
  assert.equal(signal?.kind, "steer");
  assert.equal(signal?.text, "Member: include the rollback step");
  assert.equal(signal?.request?.actor.externalId, "member");
  assert.equal((await built.runs.list()).length, 1);

  await built.runs.withdraw(runId);
  const busy = await say(meeting, "member", "anyone there?");
  assert.equal(busy.status, "refused");
  assert.equal(busy.refusalKind, "session_busy");
  await built.sessions.releaseLease(lease);
  assert.equal((await say(meeting, "member", "anyone there?")).status, "silent");
});

test("ending a meeting captures the whole discussion into project memory once", async (t) => {
  const { built, project, call, start, say } = await meetingFixture(t, "memory");
  const scope = projectScopeId(project.id);
  const meeting = await start({ mode: "off" });
  assert.equal((await say(meeting, "member", "remember that the launch date is march 3")).status, "silent");
  assert.equal((await say(meeting, "owner", "remember that billing must stay untouched")).status, "silent");
  assert.doesNotMatch(await built.memory.read(scope), /launch date/);

  assert.equal((await call("POST", `/v1/meetings/${meeting.sessionId}/end`, { principalId: "owner" })).status, 200);
  const captured = await built.memory.read(scope);
  assert.match(captured, /the launch date is march 3/);
  assert.match(captured, /billing must stay untouched/);

  assert.equal((await call("POST", `/v1/meetings/${meeting.sessionId}/end`, { principalId: "member" })).status, 200);
  assert.equal(await built.memory.read(scope), captured);
});

test("ending with outputs opens a follow-up project chat that writes the chosen documents", async (t) => {
  const { built, project, call, start, say } = await meetingFixture(t, "outputs");
  const meeting = await start({ title: "Pricing review" });
  assert.equal((await say(meeting, "member", "we agreed to add a team tier")).status, "silent");

  const bad = await call("POST", `/v1/meetings/${meeting.sessionId}/end`, { principalId: "owner", outputs: ["poem"] });
  assert.equal(bad.status, 400);
  assert.equal((await built.meetings.get(meeting.threadRef))?.status, "open");

  const ended = await call("POST", `/v1/meetings/${meeting.sessionId}/end`, {
    principalId: "owner",
    outputs: ["tasks", "minutes"],
  });
  assert.equal(ended.status, 200);
  const closed = ((await ended.json()) as { meeting: Meeting }).meeting;
  assert.deepEqual(closed.outputs, ["tasks", "minutes"]);
  assert.ok(closed.followUpSessionId);

  const followUp = await built.sessions.get(closed.followUpSessionId!);
  assert.equal(followUp?.scopeId, projectScopeId(project.id));
  assert.equal(followUp?.title, "Pricing review outcomes");
  assert.equal(await built.meetings.get(followUp!.threadRef), null);
  assert.match(
    JSON.stringify((await built.app.getSessionForViewer(followUp!.id, "member"))?.entries),
    /we agreed to add a team tier/,
  );

  const [run] = (await built.runs.list()).filter((candidate) => candidate.sessionId === followUp!.threadRef);
  assert.ok(run);
  assert.equal(run.request.actor.id, "owner");
  assert.equal(run.request.displayText, "Generate from this meeting: meeting minutes, task checklist.");
  const folder = meetingOutputsFolder(meeting.sessionId, closed.endedAt!);
  assert.ok(run.request.text.includes(`\`${folder}/minutes.md\``));
  assert.ok(run.request.text.includes(`\`${folder}/tasks.md\``));
  assert.ok(!run.request.text.includes("action-plan.md"));

  const again = await call("POST", `/v1/meetings/${meeting.sessionId}/end`, {
    principalId: "member",
    outputs: ["action_plan"],
  });
  assert.equal(((await again.json()) as { meeting: Meeting }).meeting.followUpSessionId, closed.followUpSessionId);
  assert.equal((await built.runs.list()).length, 1);
});

test("session views carry the meeting so a client can render its state", async (t) => {
  const { built, call, start } = await meetingFixture(t, "views");
  const meeting = await start({ mode: "judged", prompt: "Stay brief." });
  const plain = await built.app.spawnSession("owner", {
    scopeId: (await built.sessions.get(meeting.sessionId))!.scopeId,
  });
  assert.ok(plain);

  const listed = await built.app.listSessions("member");
  assert.deepEqual(listed.find((session) => session.id === meeting.sessionId)?.meeting, {
    mode: "judged",
    status: "open",
    prompt: "Stay brief.",
    startedBy: "owner",
  });
  assert.equal(listed.find((session) => session.id === plain.session.id)?.meeting, undefined);
  assert.equal((await built.app.getSessionForViewer(meeting.sessionId, "member"))?.session.meeting?.mode, "judged");

  await call("POST", `/v1/meetings/${meeting.sessionId}/end`, { principalId: "member", outputs: ["minutes"] });
  const after = (await built.app.listSessions("owner")).find((session) => session.id === meeting.sessionId)?.meeting;
  assert.equal(after?.status, "ended");
  assert.ok(after?.followUpSessionId);
});

test("transcript chunks name each speaker and split on message boundaries", () => {
  const entry = (seq: number, type: "user" | "assistant" | "system", payload: unknown) => ({
    sessionId: "s1",
    seq,
    parentSeq: null,
    type,
    payload,
    scopeLabel: "group:web-project-p1" as const,
    createdAt: seq,
  });
  const entries = [
    entry(1, "user", { text: "ship friday", name: "Member" }),
    entry(2, "system", { kind: "note", text: "ignored" }),
    entry(3, "user", { text: "wake prompt", hidden: true }),
    entry(4, "assistant", { text: "Friday works." }),
    entry(5, "user", { text: "agreed" }),
  ];
  assert.deepEqual(transcriptChunks(entries), ["Member: ship friday\nAssistant: Friday works.\nMember: agreed"]);
  assert.deepEqual(transcriptChunks(entries, 30), [
    "Member: ship friday",
    "Assistant: Friday works.",
    "Member: agreed",
  ]);
  assert.deepEqual(transcriptChunks([]), []);
});

test("an ended meeting is locked for messages, settings, and turns", async (t) => {
  const { call, start, say, transcript } = await meetingFixture(t, "ended");
  const meeting = await start();
  assert.equal((await say(meeting, "member", "final decision: ship it")).status, "silent");

  assert.equal((await call("POST", `/v1/meetings/${meeting.sessionId}/end`, { principalId: "outsider" })).status, 404);
  const ended = await call("POST", `/v1/meetings/${meeting.sessionId}/end`, { principalId: "member" });
  assert.equal(ended.status, 200);
  const closed = ((await ended.json()) as { meeting: Meeting }).meeting;
  assert.equal(closed.status, "ended");
  assert.equal(closed.endedBy, "member");
  const again = await call("POST", `/v1/meetings/${meeting.sessionId}/end`, { principalId: "owner" });
  assert.equal(((await again.json()) as { meeting: Meeting }).meeting.endedBy, "member");

  assert.equal(
    (await call("PATCH", `/v1/meetings/${meeting.sessionId}`, { principalId: "owner", mode: "judged" })).status,
    409,
  );
  for (const extra of [{}, { mentionsAssistant: true }, { triggered: true }]) {
    const refused = await say(meeting, "owner", "reopen this", extra);
    assert.equal(refused.status, "refused");
    assert.match(refused.reason ?? "", /meeting has ended/);
  }
  assert.match(await transcript(meeting, "owner"), /final decision: ship it/);
  assert.doesNotMatch(await transcript(meeting, "owner"), /reopen this/);
});
