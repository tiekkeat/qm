import { orgId as orgIdOf } from "../config.ts";
import { renderOverheard, type OverheardEntryPayload } from "../harness/replay.ts";
import {
  isMeetingOutput,
  meetingOutputsFolder,
  meetingOutputsRequest,
  type MeetingOutput,
} from "../meetings/meeting-outputs.ts";
import { isMeetingMode, MAX_MEETING_PROMPT_CHARS, type Meeting } from "../meetings/meeting-store.ts";
import { projectGroupRef, projectScopeId } from "../projects/project-store.ts";
import { resolveBranding } from "../resolution/branding.ts";
import { isTerminal } from "../runs/run-store.ts";
import { acquireLeaseWithin, appendEntryOutsideTurn } from "../sessions/session-store.ts";
import {
  judgeAmbientBatch,
  renderAmbientPrompt,
  type AmbientBatch,
  type AmbientDecision,
} from "../surface-cache/ambient-judge.ts";
import type { CachedMessage } from "../surface-cache/surface-cache.ts";
import {
  parseScopeId,
  scopeId,
  type Principal,
  type Session,
  type SessionEntry,
  type TurnRequest,
  type TurnResult,
} from "../types.ts";
import { reportFailureAs, swallowAs } from "../util/errors.ts";

import type { App, AppDeps } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";

const RECORD_LEASE_WAIT_MS = 15_000;
const RECORD_DEDUPE_SCAN = 200;
const JUDGE_BACKDROP_ENTRIES = 12;
const MAX_MEETING_MESSAGE_CHARS = 40_000;

function messageTs(at: number, nonce: number): string {
  return `${(at / 1000).toFixed(3)}${String(nonce % 1000).padStart(3, "0")}`;
}

function entryAsCachedMessage(entry: SessionEntry, container: string): CachedMessage | null {
  if (entry.type !== "user" && entry.type !== "assistant") return null;
  const payload = entry.payload as { text?: unknown; name?: unknown; ts?: unknown; hidden?: unknown } | null;
  if (!payload || payload.hidden === true || typeof payload.text !== "string" || !payload.text.trim()) return null;
  return {
    container,
    ts: typeof payload.ts === "string" && payload.ts ? payload.ts : messageTs(entry.createdAt, entry.seq),
    text: payload.text,
    createdAt: entry.createdAt,
    ...(entry.type === "assistant" ? { self: true } : {}),
    ...(typeof payload.name === "string" && payload.name.trim() ? { authorName: payload.name.trim() } : {}),
  };
}

export type MeetingIntake = (input: {
  meeting: Meeting;
  actor: Principal;
  request: TurnRequest;
}) => Promise<"wake" | TurnResult>;

export function createMeetingMethods(
  deps: AppDeps,
  app: App,
  h: AppHelpers,
): {
  methods: Pick<App, "startMeeting" | "listMeetings" | "updateMeeting" | "endMeeting">;
  intake: MeetingIntake;
} {
  const { sessionForViewer } = h;

  async function isProjectMember(projectId: string, principalId: string): Promise<boolean> {
    if (!deps.projects || !deps.identity.isInternal(deps.identity.classify(principalId))) return false;
    return (await deps.projects.membership(projectGroupRef(projectId), principalId)) === true;
  }

  async function meetingForViewer(
    sessionId: string,
    principalId: string,
  ): Promise<{ session: Session; meeting: Meeting } | null> {
    if (!deps.meetings) return null;
    const session = await sessionForViewer(sessionId, principalId);
    if (!session) return null;
    const meeting = await deps.meetings.get(session.threadRef);
    if (!meeting || meeting.sessionId !== session.id) return null;
    return (await isProjectMember(meeting.projectId, principalId)) ? { session, meeting } : null;
  }

  async function announce(session: Session): Promise<void> {
    deps.sessionStateBus?.emit({
      threadRef: session.threadRef,
      sessionId: session.id,
      participants: await deps.sessions.participantsOf(session.id),
      state: "metadata",
      at: Date.now(),
    });
  }

  async function speakerName(principalId: string): Promise<string | undefined> {
    const member = await deps.directory.get(principalId).catch(swallowAs("meetings: speaker lookup", null));
    return member?.displayName?.trim() || undefined;
  }

  async function record(
    session: Session,
    payload: OverheardEntryPayload,
    messageKey: string | undefined,
  ): Promise<SessionEntry | null> {
    const attempt = await acquireLeaseWithin(deps.sessions, session.id, "backfill", RECORD_LEASE_WAIT_MS, {
      waitFor: (heldBy) => heldBy !== "turn",
    });
    if (!attempt.lease) return null;
    try {
      if (messageKey) {
        const tail = await deps.sessions.getEntries(session.id, { limit: RECORD_DEDUPE_SCAN });
        const prior = tail.find(
          (entry) =>
            entry.type === "user" && (entry.payload as { messageKey?: unknown } | null)?.messageKey === messageKey,
        );
        if (prior) return prior;
      }
      return await appendEntryOutsideTurn(
        deps.sessions,
        attempt.lease,
        { type: "user", payload: messageKey ? { ...payload, messageKey } : payload, scopeLabel: session.scopeId },
        () => renderOverheard(payload),
      );
    } finally {
      await deps.sessions.releaseLease(attempt.lease);
    }
  }

  async function shouldEngage(session: Session, meeting: Meeting, message: CachedMessage): Promise<boolean> {
    const judge = deps.ambientJudge;
    if (!judge) return false;
    const recent = await deps.sessions
      .getEntries(session.id, { limit: JUDGE_BACKDROP_ENTRIES })
      .catch(swallowAs("meetings: judge backdrop", [] as SessionEntry[]));
    const backdrop = recent
      .map((entry) => entryAsCachedMessage(entry, session.threadRef))
      .filter((cached): cached is CachedMessage => cached !== null);
    const selfName = (await resolveBranding(deps.config, scopeId("org", orgIdOf()))).selfLabel;
    const batch: AmbientBatch = {
      container: session.threadRef,
      surface: meeting.surface,
      kind: "group",
      orders: meeting.prompt,
      ...(selfName ? { self: { name: selfName } } : {}),
      messages: [message],
      ...(backdrop.length ? { backdrop } : {}),
    };
    const startedAt = Date.now();
    const decision = await judgeAmbientBatch({ judge, spawnWorker: async () => {} }, batch).catch(
      swallowAs<AmbientDecision>("meetings: judge", { act: false }),
    );
    const judgeModel = deps.judgeModelId?.();
    void deps.ambientJudgments
      ?.record({
        surface: meeting.surface,
        container: session.threadRef,
        decision: decision.act ? "act" : "ignore",
        ...(decision.reason ? { reason: decision.reason } : {}),
        prompt: renderAmbientPrompt(batch),
        ...(judgeModel ? { model: judgeModel } : {}),
        latencyMs: Date.now() - startedAt,
        tsFrom: message.ts,
        tsTo: message.ts,
        createdAt: Date.now(),
      })
      .catch(reportFailureAs("meetings: record judgment", undefined));
    return decision.act;
  }

  async function startOutputs(
    session: Session,
    meeting: Meeting,
    principalId: string,
    outputs: readonly MeetingOutput[],
  ): Promise<Meeting | null> {
    const parsed = parseScopeId(session.scopeId);
    const forked = await app.forkSession(session.id, principalId);
    if (!forked || !parsed.ref || !deps.meetings) return null;
    const title = session.title?.trim();
    await deps.sessions.updateTitle(forked.session.id, title ? `${title} outcomes` : "Meeting outcomes");
    const request = meetingOutputsRequest(outputs, meetingOutputsFolder(session.id, meeting.endedAt ?? Date.now()));
    const name = await speakerName(principalId);
    const turn = await app.turn({
      surface: "web",
      actor: { externalId: principalId, ...(name ? { displayName: name } : {}) },
      conversation: { kind: "group", threadRef: forked.session.threadRef, channelRef: parsed.ref },
      text: request.text,
      displayText: request.display,
      spawned: true,
      async: true,
      idempotencyKey: `meeting-outputs:${session.id}`,
    });
    if (turn.status === "refused")
      console.error(`[meetings] outputs turn refused for ${session.id}: ${turn.reason ?? "no reason"}`);
    return deps.meetings.attachFollowUp(session.threadRef, forked.session.id, outputs);
  }

  const intake: MeetingIntake = async ({ meeting, actor, request }) => {
    if (meeting.mode !== "off" && request.mentionsAssistant === true) return "wake";
    const session = await deps.sessions.getByThread(meeting.threadRef);
    if (!session || session.id !== meeting.sessionId)
      return { status: "refused", reason: "this meeting's conversation is unavailable" };
    if (request.attachments?.length)
      return { status: "refused", reason: "mention the assistant to share a file in a meeting" };
    const text = request.text.trim();
    if (!text) return { status: "refused", reason: "a meeting message needs text" };
    if (text.length > MAX_MEETING_MESSAGE_CHARS)
      return { status: "refused", reason: `a meeting message is capped at ${MAX_MEETING_MESSAGE_CHARS} characters` };

    const at = Date.now();
    const name = actor.displayName?.trim() || (await speakerName(actor.id));
    const payload: OverheardEntryPayload = {
      overheard: true,
      ts: messageTs(at, Math.floor(Math.random() * 1000)),
      text,
      ...(name ? { name } : {}),
    };
    if (
      meeting.mode === "judged" &&
      (await shouldEngage(session, meeting, {
        container: session.threadRef,
        ts: payload.ts,
        text,
        createdAt: at,
        authorId: actor.id,
        ...(name ? { authorName: name } : {}),
      }))
    )
      return "wake";

    const messageKey = request.idempotencyKey ? `meeting:${actor.id}:${request.idempotencyKey}` : undefined;
    if (await record(session, payload, messageKey)) {
      await announce(session);
      return { status: "silent", sessionId: session.id };
    }
    const live = await deps.runs.activeForThread(session.threadRef);
    if (live && !isTerminal(live.status)) {
      const attributed = name ? { ...request, actor: { ...request.actor, displayName: name } } : request;
      const steer = await app.signalRun(
        live.id,
        { kind: "steer", text, ts: payload.ts, request: attributed },
        actor.id,
      );
      if (steer.accepted || steer.replayed)
        return { status: "queued", runId: live.id, steered: true, sessionId: session.id };
    }
    return {
      status: "refused",
      refusalKind: "session_busy",
      reason: "the meeting is busy; send the message again",
    };
  };

  const methods: Pick<App, "startMeeting" | "listMeetings" | "updateMeeting" | "endMeeting"> = {
    async startMeeting(projectId, principalId, input) {
      if (!deps.meetings || !deps.projects) return { status: "not_found" };
      if (input.mode !== undefined && !isMeetingMode(input.mode)) return { status: "invalid", message: "unknown mode" };
      if (input.prompt !== undefined && input.prompt.length > MAX_MEETING_PROMPT_CHARS)
        return { status: "invalid", message: `prompt is capped at ${MAX_MEETING_PROMPT_CHARS} characters` };
      const project = await deps.projects.get(projectId);
      if (!project || project.orgId !== orgIdOf()) return { status: "not_found" };
      if (!(await isProjectMember(projectId, principalId))) return { status: "forbidden" };
      const spawned = await app.spawnSession(principalId, {
        scopeId: projectScopeId(projectId),
        ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      });
      if (!spawned) return { status: "forbidden" };
      const meeting = await deps.meetings.create({
        threadRef: spawned.session.threadRef,
        sessionId: spawned.session.id,
        projectId,
        surface: "web",
        startedBy: principalId,
        ...(input.mode !== undefined ? { mode: input.mode } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      });
      deps.auditLog.record({
        at: Date.now(),
        principalId,
        action: "meeting.start",
        resource: meeting.sessionId,
        scopeLabel: projectScopeId(projectId),
        detail: JSON.stringify({ mode: meeting.mode }),
      });
      return { status: "ok", meeting };
    },

    async listMeetings(projectId, principalId) {
      if (!deps.meetings || !(await isProjectMember(projectId, principalId))) return null;
      return deps.meetings.listForProject(projectId);
    },

    async updateMeeting(sessionId, principalId, patch) {
      const found = await meetingForViewer(sessionId, principalId);
      if (!found || !deps.meetings) return { status: "not_found" };
      if (found.meeting.status !== "open") return { status: "ended" };
      if (patch.mode !== undefined && !isMeetingMode(patch.mode)) return { status: "invalid", message: "unknown mode" };
      if (patch.prompt !== undefined) {
        if (found.meeting.startedBy !== principalId) return { status: "forbidden" };
        if (patch.prompt.length > MAX_MEETING_PROMPT_CHARS)
          return { status: "invalid", message: `prompt is capped at ${MAX_MEETING_PROMPT_CHARS} characters` };
      }
      if (patch.mode === undefined && patch.prompt === undefined) return { status: "ok", meeting: found.meeting };
      const meeting = await deps.meetings.update(found.session.threadRef, patch);
      if (!meeting) return { status: "ended" };
      deps.auditLog.record({
        at: Date.now(),
        principalId,
        action: "meeting.update",
        resource: meeting.sessionId,
        scopeLabel: found.session.scopeId,
        detail: JSON.stringify({
          ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
          ...(patch.prompt !== undefined ? { promptChanged: true } : {}),
        }),
      });
      await announce(found.session);
      return { status: "ok", meeting };
    },

    async endMeeting(sessionId, principalId, input) {
      const found = await meetingForViewer(sessionId, principalId);
      if (!found || !deps.meetings) return { status: "not_found" };
      const outputs = input?.outputs ?? [];
      if (!outputs.every(isMeetingOutput)) return { status: "invalid", message: "unknown output" };
      const ended = await deps.meetings.end(found.session.threadRef, principalId);
      if (!ended) return { status: "not_found" };
      if (!ended.changed) return { status: "ok", meeting: ended.meeting };
      deps.auditLog.record({
        at: Date.now(),
        principalId,
        action: "meeting.end",
        resource: ended.meeting.sessionId,
        scopeLabel: found.session.scopeId,
        detail: JSON.stringify({ outputs }),
      });
      await deps.orchestrator.captureTranscript(found.session.id, principalId);
      const followUp = outputs.length ? await startOutputs(found.session, ended.meeting, principalId, outputs) : null;
      await announce(found.session);
      return { status: "ok", meeting: followUp ?? ended.meeting };
    },
  };
  return { methods, intake };
}
