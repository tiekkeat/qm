import { isMeetingMode, type MeetingMode } from "../../meetings/meeting-store.ts";
import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

type MeetingOutcome = Awaited<ReturnType<ApiCtx["app"]["updateMeeting"]>>;

function principalOf(ctx: ApiCtx, principalId: string): string | null {
  if (principalId) return principalId;
  sendJson(ctx.res, 400, { error: "bad_request", message: "principalId required" });
  return null;
}

function bodyPrincipal(ctx: ApiCtx): { principalId: string; body: Record<string, unknown> } | null {
  const body = isObj(ctx.body) ? ctx.body : {};
  const principalId = principalOf(ctx, typeof body.principalId === "string" ? body.principalId.trim() : "");
  return principalId === null ? null : { principalId, body };
}

function settings(ctx: ApiCtx, body: Record<string, unknown>): { mode?: MeetingMode; prompt?: string } | null {
  if (body.mode !== undefined && !isMeetingMode(body.mode)) {
    sendJson(ctx.res, 400, { error: "bad_request", message: "mode must be mention, judged, or off" });
    return null;
  }
  if (body.prompt !== undefined && typeof body.prompt !== "string") {
    sendJson(ctx.res, 400, { error: "bad_request", message: "prompt must be a string" });
    return null;
  }
  return {
    ...(isMeetingMode(body.mode) ? { mode: body.mode } : {}),
    ...(typeof body.prompt === "string" ? { prompt: body.prompt } : {}),
  };
}

function respond(ctx: ApiCtx, result: MeetingOutcome, okStatus = 200): void {
  if (result.status === "ok") return sendJson(ctx.res, okStatus, { meeting: result.meeting });
  if (result.status === "invalid") return sendJson(ctx.res, 400, { error: "bad_request", message: result.message });
  if (result.status === "ended")
    return sendJson(ctx.res, 409, { error: "meeting_ended", message: "this meeting has ended" });
  if (result.status === "forbidden") return sendJson(ctx.res, 403, { error: "forbidden" });
  return sendJson(ctx.res, 404, { error: "not_found" });
}

async function listMeetings(ctx: ApiCtx): Promise<void> {
  const principalId = principalOf(ctx, (ctx.url.searchParams.get("principalId") ?? "").trim());
  if (principalId === null) return;
  const meetings = await ctx.app.listMeetings(ctx.params.id!, principalId);
  return meetings ? sendJson(ctx.res, 200, { meetings }) : sendJson(ctx.res, 404, { error: "not_found" });
}

async function startMeeting(ctx: ApiCtx): Promise<void> {
  const request = bodyPrincipal(ctx);
  if (!request) return;
  const chosen = settings(ctx, request.body);
  if (!chosen) return;
  const title = typeof request.body.title === "string" ? request.body.title : undefined;
  return respond(
    ctx,
    await ctx.app.startMeeting(ctx.params.id!, request.principalId, { ...chosen, ...(title ? { title } : {}) }),
    201,
  );
}

async function updateMeeting(ctx: ApiCtx): Promise<void> {
  const request = bodyPrincipal(ctx);
  if (!request) return;
  const chosen = settings(ctx, request.body);
  if (!chosen) return;
  return respond(ctx, await ctx.app.updateMeeting(ctx.params.sessionId!, request.principalId, chosen));
}

async function endMeeting(ctx: ApiCtx): Promise<void> {
  const request = bodyPrincipal(ctx);
  if (!request) return;
  return respond(ctx, await ctx.app.endMeeting(ctx.params.sessionId!, request.principalId));
}

async function postMeetingMessage(ctx: ApiCtx): Promise<void> {
  const request = bodyPrincipal(ctx);
  if (!request) return;
  const { body, principalId } = request;
  if (typeof body.text !== "string")
    return sendJson(ctx.res, 400, { error: "bad_request", message: "text (string) required" });
  const result = await ctx.app.postMeetingMessage(ctx.params.sessionId!, principalId, {
    text: body.text,
    ...(body.mentionsAssistant === true ? { mentionsAssistant: true } : {}),
    ...(typeof body.idempotencyKey === "string" && body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
  });
  if (result.status === "recorded") return sendJson(ctx.res, 201, { status: "recorded", seq: result.seq });
  if (result.status === "steered") return sendJson(ctx.res, 202, { status: "steered", runId: result.runId });
  if (result.status === "turn") {
    if (result.turn.status === "refused")
      return sendJson(ctx.res, 409, { error: "refused", message: result.turn.reason ?? "the turn was refused" });
    return sendJson(ctx.res, 202, { status: "turn", turn: result.turn });
  }
  if (result.status === "busy")
    return sendJson(ctx.res, 409, { error: "session_busy", message: "the meeting is busy; send the message again" });
  if (result.status === "invalid") return sendJson(ctx.res, 400, { error: "bad_request", message: result.message });
  if (result.status === "ended")
    return sendJson(ctx.res, 409, { error: "meeting_ended", message: "this meeting has ended" });
  return sendJson(ctx.res, 404, { error: "not_found" });
}

export const meetingRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/projects/:id/meetings", auth: "source", handle: listMeetings },
  { method: "POST", path: "/v1/projects/:id/meetings", auth: "source", handle: startMeeting },
  { method: "PATCH", path: "/v1/meetings/:sessionId", auth: "source", handle: updateMeeting },
  { method: "POST", path: "/v1/meetings/:sessionId/end", auth: "source", handle: endMeeting },
  { method: "POST", path: "/v1/meetings/:sessionId/messages", auth: "source", handle: postMeetingMessage },
];
