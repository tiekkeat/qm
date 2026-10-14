import { html, nothing, type TemplateResult } from "lit";
import { MessagesSquare, X } from "lucide";
import { api, type CoreContext, type CoreSession } from "./core-bridge";
import { errMessage } from "../../chassis/src/errors";
import {
  DEFAULT_MEETING_PROMPT,
  MEETING_MODES,
  MEETING_OUTPUTS,
  type MeetingMode,
  type MeetingOutput,
} from "../../chassis/src/meeting-copy";
import { mentionChoices, type MentionCandidate } from "./mention";
import { openSession, refreshSessions, sessionsState } from "./sessions";
import { tip } from "./tooltip";
import { brandName, fieldSelect, icon } from "./ui";

const PROMPT_LIMIT = 20_000;

const OUTPUT_LABELS: Record<MeetingOutput, string> = {
  minutes: "Meeting minutes",
  action_plan: "Action plan",
  tasks: "Task checklist",
};

function meetingModeLabel(mode: MeetingMode): string {
  if (mode === "mention") return `${brandName()} answers when mentioned`;
  if (mode === "judged") return `${brandName()} joins when useful`;
  return `${brandName()} is off`;
}

function meetingModeHint(mode: MeetingMode): string {
  if (mode === "mention") return `Type @ and pick ${brandName()} to get an answer. Other messages are only recorded.`;
  if (mode === "judged")
    return `${brandName()} reads every message and decides when to join in. Each message costs a small model call.`;
  return "People only. No model is called until the meeting ends.";
}

const meetingUi = {
  start: null as {
    projectId: string;
    title: string;
    mode: MeetingMode;
    prompt: string;
    saving: boolean;
    error: string;
  } | null,
  end: null as { sessionId: string; outputs: Set<MeetingOutput>; saving: boolean; error: string } | null,
  prompt: null as { sessionId: string; draft: string; editable: boolean; saving: boolean; error: string } | null,
  switchingMode: false,
  notice: "",
};

let redraw: () => void = () => {};
const membersByScope = new Map<string, string[]>();
const membersLoading = new Set<string>();

export function openMeetingFor(threadRef: string | null, sessionId: string | null): CoreSession | undefined {
  const session = sessionsState.list.find((candidate) =>
    sessionId ? candidate.id === sessionId : Boolean(threadRef) && candidate.threadRef === threadRef,
  );
  return session?.meeting ? session : undefined;
}

export function mentionCandidates(session: CoreSession | undefined, query: string): MentionCandidate[] {
  const meeting = session?.meeting;
  if (!session || meeting?.status !== "open") return [];
  return mentionChoices(meeting.mode === "off" ? null : brandName(), membersByScope.get(session.scopeId) ?? [], query);
}

export function loadMeetingMembers(scopeId: string, onLoaded: () => void): void {
  if (membersByScope.has(scopeId) || membersLoading.has(scopeId)) return;
  membersLoading.add(scopeId);
  void api<{ contexts: CoreContext[] }>("/api/contexts")
    .then((result) => {
      for (const context of result.contexts ?? []) {
        if (!context.project) continue;
        membersByScope.set(
          context.scopeId,
          context.project.members.map((member) => member.displayName.trim()).filter(Boolean),
        );
      }
      if (!membersByScope.has(scopeId)) membersByScope.set(scopeId, []);
      onLoaded();
    })
    .catch(() => undefined)
    .finally(() => membersLoading.delete(scopeId));
}

async function openById(sessionId: string): Promise<void> {
  await refreshSessions({ silent: true });
  const session = sessionsState.list.find((candidate) => candidate.id === sessionId);
  if (session) await openSession(session);
}

export function openStartMeeting(projectId: string, draw: () => void): void {
  redraw = draw;
  meetingUi.start = { projectId, title: "", mode: "mention", prompt: DEFAULT_MEETING_PROMPT, saving: false, error: "" };
  redraw();
  queueMicrotask(() => document.querySelector<HTMLInputElement>("#meeting-title")?.focus());
}

function closeStartMeeting(): void {
  meetingUi.start = null;
  redraw();
}

async function submitStartMeeting(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const start = meetingUi.start;
  if (!start || start.saving) return;
  start.saving = true;
  start.error = "";
  redraw();
  try {
    const result = await api<{ meeting?: { sessionId?: string } }>(
      `/api/projects/${encodeURIComponent(start.projectId)}/meetings`,
      {
        method: "POST",
        body: JSON.stringify({ title: start.title, mode: start.mode, prompt: start.prompt }),
      },
    );
    const sessionId = result.meeting?.sessionId;
    if (!sessionId) throw new Error("The meeting could not be started.");
    meetingUi.start = null;
    await openById(sessionId);
  } catch (error) {
    if (meetingUi.start !== start) return;
    start.saving = false;
    start.error = errMessage(error, "Couldn't start the meeting.");
    redraw();
  }
}

function modeOptions(): TemplateResult[] {
  return MEETING_MODES.map((mode) => html`<option value=${mode}>${meetingModeLabel(mode)}</option>`);
}

export function startMeetingDialog(): TemplateResult | typeof nothing {
  const start = meetingUi.start;
  if (!start) return nothing;
  return html`
    <dialog
      class="project-dialog meeting-dialog"
      aria-labelledby="meeting-start-title"
      @close=${closeStartMeeting}
      @click=${(event: MouseEvent) => event.target === event.currentTarget && (event.currentTarget as HTMLDialogElement).close()}
    >
      <form @submit=${(event: SubmitEvent) => void submitStartMeeting(event)}>
        <div class="project-dialog-head">
          <span class="context-glyph large">${icon(MessagesSquare, 21)}</span>
          <div><h2 id="meeting-start-title">New meeting</h2></div>
          <button
            class="project-icon-button"
            type="button"
            aria-label="Close new meeting"
            ${tip("Close")}
            @click=${closeStartMeeting}
          >
            ${icon(X, 16)}
          </button>
        </div>
        <label class="project-name-field" for="meeting-title">
          <span>Title</span>
          <input
            id="meeting-title"
            data-focus-key="meeting-title"
            maxlength="200"
            autocomplete="off"
            placeholder="Pricing review"
            .value=${start.title}
            ?disabled=${start.saving}
            @input=${(event: InputEvent) => {
              start.title = (event.currentTarget as HTMLInputElement).value;
            }}
          />
        </label>
        <div class="meeting-field">
          <label class="ambient-field-label" for="meeting-start-mode">Assistant</label>
          ${fieldSelect({
            id: "meeting-start-mode",
            focusKey: "meeting-start-mode",
            describedBy: "meeting-start-mode-hint",
            disabled: start.saving,
            value: start.mode,
            onChange: (value) => {
              start.mode = value as MeetingMode;
              redraw();
            },
            options: modeOptions(),
          })}
          <p class="ambient-policy-hint" id="meeting-start-mode-hint">${meetingModeHint(start.mode)}</p>
        </div>
        <div class="meeting-field">
          <label class="ambient-field-label" for="meeting-start-prompt">Instructions for ${brandName()}</label>
          <textarea
            id="meeting-start-prompt"
            data-focus-key="meeting-start-prompt"
            class="ambient-orders"
            rows="6"
            maxlength=${PROMPT_LIMIT}
            .value=${start.prompt}
            ?disabled=${start.saving}
            @input=${(event: InputEvent) => {
              start.prompt = (event.currentTarget as HTMLTextAreaElement).value;
            }}
          ></textarea>
        </div>
        <div class="form-error" aria-live="polite">${start.error}</div>
        <div class="project-dialog-actions">
          <button class="btn" type="button" @click=${closeStartMeeting}>Cancel</button>
          <button class="btn primary" type="submit" ?disabled=${start.saving}>
            ${icon(MessagesSquare, 15)}<span>${start.saving ? "Starting…" : "Start meeting"}</span>
          </button>
        </div>
      </form>
    </dialog>
  `;
}

async function changeMode(session: CoreSession, mode: MeetingMode): Promise<void> {
  if (meetingUi.switchingMode || session.meeting?.mode === mode) return;
  meetingUi.switchingMode = true;
  meetingUi.notice = "";
  redraw();
  try {
    await api(`/api/meetings/${encodeURIComponent(session.id)}`, { method: "PATCH", body: JSON.stringify({ mode }) });
    await refreshSessions({ silent: true });
  } catch (error) {
    meetingUi.notice = errMessage(error, "Couldn't change the assistant mode.");
  } finally {
    meetingUi.switchingMode = false;
    redraw();
  }
}

function openPrompt(session: CoreSession, viewer: string | undefined): void {
  meetingUi.prompt = {
    sessionId: session.id,
    draft: session.meeting?.prompt ?? "",
    editable: session.meeting?.status === "open" && session.meeting.startedBy === viewer,
    saving: false,
    error: "",
  };
  redraw();
}

function closePrompt(): void {
  meetingUi.prompt = null;
  redraw();
}

async function submitPrompt(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const prompt = meetingUi.prompt;
  if (!prompt || prompt.saving || !prompt.editable) return;
  prompt.saving = true;
  prompt.error = "";
  redraw();
  try {
    await api(`/api/meetings/${encodeURIComponent(prompt.sessionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ prompt: prompt.draft }),
    });
    await refreshSessions({ silent: true });
    meetingUi.prompt = null;
    redraw();
  } catch (error) {
    if (meetingUi.prompt !== prompt) return;
    prompt.saving = false;
    prompt.error = errMessage(error, "Couldn't save the instructions.");
    redraw();
  }
}

function openEnd(session: CoreSession): void {
  meetingUi.end = { sessionId: session.id, outputs: new Set(), saving: false, error: "" };
  redraw();
}

function closeEnd(): void {
  meetingUi.end = null;
  redraw();
}

async function submitEnd(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const end = meetingUi.end;
  if (!end || end.saving) return;
  end.saving = true;
  end.error = "";
  redraw();
  try {
    const result = await api<{ meeting?: { followUpSessionId?: string } }>(
      `/api/meetings/${encodeURIComponent(end.sessionId)}/end`,
      {
        method: "POST",
        body: JSON.stringify({ outputs: MEETING_OUTPUTS.filter((output) => end.outputs.has(output)) }),
      },
    );
    meetingUi.end = null;
    const followUp = result.meeting?.followUpSessionId;
    if (followUp) await openById(followUp);
    else await refreshSessions({ silent: true });
    redraw();
  } catch (error) {
    if (meetingUi.end !== end) return;
    end.saving = false;
    end.error = errMessage(error, "Couldn't end the meeting.");
    redraw();
  }
}

function promptDialog(): TemplateResult | typeof nothing {
  const prompt = meetingUi.prompt;
  if (!prompt) return nothing;
  return html`
    <dialog
      class="project-dialog meeting-dialog"
      aria-labelledby="meeting-prompt-title"
      @close=${closePrompt}
      @click=${(event: MouseEvent) => event.target === event.currentTarget && (event.currentTarget as HTMLDialogElement).close()}
    >
      <form @submit=${(event: SubmitEvent) => void submitPrompt(event)}>
        <div class="project-dialog-head">
          <div><h2 id="meeting-prompt-title">Instructions for ${brandName()}</h2></div>
          <button class="project-icon-button" type="button" aria-label="Close instructions" @click=${closePrompt}>
            ${icon(X, 16)}
          </button>
        </div>
        <div class="meeting-field">
          <textarea
            id="meeting-prompt"
            data-focus-key="meeting-prompt"
            class="ambient-orders"
            rows="8"
            aria-labelledby="meeting-prompt-title"
            aria-describedby="meeting-prompt-hint"
            maxlength=${PROMPT_LIMIT}
            .value=${prompt.draft}
            ?readonly=${!prompt.editable}
            ?disabled=${prompt.saving}
            @input=${(event: InputEvent) => {
              prompt.draft = (event.currentTarget as HTMLTextAreaElement).value;
            }}
          ></textarea>
          <p class="ambient-policy-hint" id="meeting-prompt-hint">
            ${prompt.editable ? "These apply to this meeting only." : "Only the member who started the meeting can change these."}
          </p>
        </div>
        <div class="form-error" aria-live="polite">${prompt.error}</div>
        <div class="project-dialog-actions">
          <button class="btn" type="button" @click=${closePrompt}>${prompt.editable ? "Cancel" : "Close"}</button>
          ${
            prompt.editable
              ? html`<button class="btn primary" type="submit" ?disabled=${prompt.saving}>
                  ${prompt.saving ? "Saving…" : "Save"}
                </button>`
              : nothing
          }
        </div>
      </form>
    </dialog>
  `;
}

function endLabel(saving: boolean, chosen: number): string {
  if (saving) return "Ending…";
  return chosen ? "End and generate" : "End meeting";
}

function endDialog(): TemplateResult | typeof nothing {
  const end = meetingUi.end;
  if (!end) return nothing;
  return html`
    <dialog
      class="project-dialog meeting-dialog"
      aria-labelledby="meeting-end-title"
      @close=${closeEnd}
      @click=${(event: MouseEvent) => event.target === event.currentTarget && (event.currentTarget as HTMLDialogElement).close()}
    >
      <form @submit=${(event: SubmitEvent) => void submitEnd(event)}>
        <div class="project-dialog-head">
          <div>
            <h2 id="meeting-end-title">End meeting</h2>
            <p class="meeting-dialog-copy">
              The meeting locks and its discussion goes to this project's memory. Choose what ${brandName()} should
              write from it.
            </p>
          </div>
          <button class="project-icon-button" type="button" aria-label="Close end meeting" @click=${closeEnd}>
            ${icon(X, 16)}
          </button>
        </div>
        <fieldset class="meeting-outputs" ?disabled=${end.saving}>
          <legend class="ambient-field-label">Documents</legend>
          ${MEETING_OUTPUTS.map(
            (output) => html`
              <label class="meeting-output">
                <input
                  type="checkbox"
                  data-focus-key=${`meeting-output-${output}`}
                  .checked=${end.outputs.has(output)}
                  @change=${(event: Event) => {
                    if ((event.currentTarget as HTMLInputElement).checked) end.outputs.add(output);
                    else end.outputs.delete(output);
                    redraw();
                  }}
                />
                <span>${OUTPUT_LABELS[output]}</span>
              </label>
            `,
          )}
        </fieldset>
        <div class="form-error" aria-live="polite">${end.error}</div>
        <div class="project-dialog-actions">
          <button class="btn" type="button" @click=${closeEnd}>Cancel</button>
          <button class="btn primary" type="submit" ?disabled=${end.saving}>
            ${endLabel(end.saving, end.outputs.size)}
          </button>
        </div>
      </form>
    </dialog>
  `;
}

export function meetingBar(
  session: CoreSession | undefined,
  viewer: string | undefined,
  draw: () => void,
): TemplateResult | typeof nothing {
  const meeting = session?.meeting;
  if (!session || !meeting) return nothing;
  redraw = draw;
  if (meeting.status === "ended") {
    const followUp = meeting.followUpSessionId;
    return html`
      <div class="meeting-bar ended" role="region" aria-label="Meeting">
        <span class="meeting-badge">${icon(MessagesSquare, 14)}<span>Meeting ended</span></span>
        <span class="meeting-bar-copy">This meeting is locked. Start a new one to keep talking.</span>
        <span class="meeting-bar-actions">
          <button class="btn" type="button" @click=${() => openPrompt(session, viewer)}>Instructions</button>
          ${
            followUp
              ? html`<button class="btn primary" type="button" @click=${() => void openById(followUp)}>
                  Open outcomes
                </button>`
              : nothing
          }
        </span>
        ${promptDialog()}
      </div>
    `;
  }
  return html`
    <div class="meeting-bar" role="region" aria-label="Meeting">
      <span class="meeting-badge">${icon(MessagesSquare, 14)}<span>Meeting</span></span>
      ${fieldSelect({
        id: "meeting-mode",
        focusKey: "meeting-mode",
        ariaLabel: "Assistant mode",
        ariaDescription: meetingModeHint(meeting.mode),
        compact: true,
        className: "meeting-mode-select",
        disabled: meetingUi.switchingMode,
        value: meeting.mode,
        onChange: (value) => void changeMode(session, value as MeetingMode),
        options: modeOptions(),
      })}
      ${meetingUi.notice ? html`<span class="meeting-bar-copy error" aria-live="polite">${meetingUi.notice}</span>` : nothing}
      <span class="meeting-bar-actions">
        <button class="btn" type="button" @click=${() => openPrompt(session, viewer)}>Instructions</button>
        <button class="btn danger" type="button" @click=${() => openEnd(session)}>End meeting</button>
      </span>
      ${promptDialog()} ${endDialog()}
    </div>
  `;
}

export function meetingComposerHint(session: CoreSession | undefined): string | null {
  const meeting = session?.meeting;
  if (!meeting || meeting.status !== "open") return null;
  if (meeting.mode === "off") return "Message the meeting";
  return `Message the meeting, or type @ to ask ${brandName()}`;
}
