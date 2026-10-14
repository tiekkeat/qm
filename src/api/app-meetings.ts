import { orgId as orgIdOf } from "../config.ts";
import { renderOverheard, type OverheardEntryPayload } from "../harness/replay.ts";
import { isMeetingMode, MAX_MEETING_PROMPT_CHARS, type Meeting } from "../meetings/meeting-store.ts";
import { projectGroupRef, projectIdFromGroupRef, projectScopeId } from "../projects/project-store.ts";
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
import { parseScopeId, scopeId, type Session, type SessionEntry, type TurnRequest } from "../types.ts";
import { reportFailureAs, swallowAs } from "../util/errors.ts";

import type { App, AppDeps } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";

const RECORD_LEASE_WAIT_MS = 15_000;
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

export function createMeetingMethods(
  deps: AppDeps,
  app: App,
  h: AppHelpers,
): Pick<App, "startMeeting" | "listMeetings" | "updateMeeting" | "endMeeting" | "postMeetingMessage"> {
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

  async function record(session: Session, payload: OverheardEntryPayload): Promise<SessionEntry | null> {
    const attempt = await acquireLeaseWithin(deps.sessions, session.id, "backfill", RECORD_LEASE_WAIT_MS, {
      waitFor: (heldBy) => heldBy !== "turn",
    });
    if (!attempt.lease) return null;
    try {
      return await appendEntryOutsideTurn(
        deps.sessions,
        attempt.lease,
        { type: "user", payload, scopeLabel: session.scopeId },
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

  return {
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

    async endMeeting(sessionId, principalId) {
      const found = await meetingForViewer(sessionId, principalId);
      if (!found || !deps.meetings) return { status: "not_found" };
      const ended = await deps.meetings.end(found.session.threadRef, principalId);
      if (!ended) return { status: "not_found" };
      if (ended.changed) {
        deps.auditLog.record({
          at: Date.now(),
          principalId,
          action: "meeting.end",
          resource: ended.meeting.sessionId,
          scopeLabel: found.session.scopeId,
        });
        await announce(found.session);
      }
      return { status: "ok", meeting: ended.meeting };
    },

    async postMeetingMessage(sessionId, principalId, input) {
      const found = await meetingForViewer(sessionId, principalId);
      if (!found) return { status: "not_found" };
      const { session, meeting } = found;
      if (meeting.status !== "open") return { status: "ended" };
      const text = input.text.trim();
      if (!text) return { status: "invalid", message: "text required" };
      if (text.length > MAX_MEETING_MESSAGE_CHARS)
        return { status: "invalid", message: `message is capped at ${MAX_MEETING_MESSAGE_CHARS} characters` };
      const parsed = parseScopeId(session.scopeId);
      if (parsed.kind !== "group" || projectIdFromGroupRef(parsed.ref) !== meeting.projectId)
        return { status: "not_found" };

      const at = Date.now();
      const name = await speakerName(principalId);
      const payload: OverheardEntryPayload = {
        overheard: true,
        ts: messageTs(at, Math.floor(Math.random() * 1000)),
        text,
        ...(name ? { name } : {}),
      };
      const wake =
        meeting.mode !== "off" &&
        (input.mentionsAssistant === true ||
          (meeting.mode === "judged" &&
            (await shouldEngage(session, meeting, {
              container: session.threadRef,
              ts: payload.ts,
              text,
              createdAt: at,
              authorId: principalId,
              ...(name ? { authorName: name } : {}),
            }))));

      const request: TurnRequest = {
        surface: "web",
        actor: { externalId: principalId, ...(name ? { displayName: name } : {}) },
        conversation: { kind: "group", threadRef: session.threadRef, channelRef: parsed.ref },
        text,
        async: true,
      };
      if (wake) {
        const turn = await app.turn({
          ...request,
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        });
        return { status: "turn", turn };
      }

      const recorded = await record(session, payload);
      if (recorded) {
        await announce(session);
        return { status: "recorded", seq: recorded.seq };
      }
      const live = await deps.runs.activeForThread(session.threadRef);
      if (live && !isTerminal(live.status)) {
        const steer = await app.signalRun(live.id, { kind: "steer", text, ts: payload.ts, request }, principalId);
        if (steer.accepted || steer.replayed) return { status: "steered", runId: live.id };
      }
      return { status: "busy" };
    },
  };
}
