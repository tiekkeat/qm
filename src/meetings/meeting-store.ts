import { orgId as configOrgId } from "../config.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";

const MEETING_MODES = ["mention", "judged", "off"] as const;
export type MeetingMode = (typeof MEETING_MODES)[number];
type MeetingSurface = "web" | "slack";

const DEFAULT_MEETING_MODE: MeetingMode = "mention";
export const MAX_MEETING_PROMPT_CHARS = 20_000;

export const DEFAULT_MEETING_PROMPT = [
  "You are the moderator of this project meeting.",
  "Ground every suggestion in what this project already has: its files, documents, architecture, memory, and deployed apps.",
  "Combine the members' ideas into feasible plans that do not break anything already running in production.",
  "If a proposal would break a production app or require a major architecture change, say so plainly and repeat the warning until the members acknowledge it.",
].join("\n");

export interface Meeting {
  threadRef: string;
  sessionId: string;
  orgId: string;
  projectId: string;
  surface: MeetingSurface;
  mode: MeetingMode;
  prompt: string;
  status: "open" | "ended";
  startedBy: string;
  startedAt: number;
  updatedAt: number;
  endedBy?: string;
  endedAt?: number;
}

export interface MeetingStore {
  create(input: {
    threadRef: string;
    sessionId: string;
    projectId: string;
    surface: MeetingSurface;
    startedBy: string;
    mode?: MeetingMode;
    prompt?: string;
  }): Promise<Meeting>;
  get(threadRef: string): Promise<Meeting | null>;
  listForProject(projectId: string): Promise<Meeting[]>;
  update(threadRef: string, patch: { mode?: MeetingMode; prompt?: string }): Promise<Meeting | null>;
  end(threadRef: string, endedBy: string): Promise<{ meeting: Meeting; changed: boolean } | null>;
}

export function isMeetingMode(value: unknown): value is MeetingMode {
  return MEETING_MODES.includes(value as MeetingMode);
}

export function createMeetingStore(
  backing: DurableMap<Meeting> = createMemoryMap<Meeting>(),
  opts: { now?: () => number } = {},
): MeetingStore {
  const now = opts.now ?? Date.now;
  const own = (meeting: Meeting | null): Meeting | null => (meeting?.orgId === configOrgId() ? meeting : null);

  return {
    async create(input) {
      const at = now();
      return backing.putIfAbsent(input.threadRef, {
        threadRef: input.threadRef,
        sessionId: input.sessionId,
        orgId: configOrgId(),
        projectId: input.projectId,
        surface: input.surface,
        mode: input.mode ?? DEFAULT_MEETING_MODE,
        prompt: input.prompt ?? DEFAULT_MEETING_PROMPT,
        status: "open",
        startedBy: input.startedBy,
        startedAt: at,
        updatedAt: at,
      });
    },
    async get(threadRef) {
      return own(await backing.get(threadRef));
    },
    async listForProject(projectId) {
      return (await backing.all())
        .filter((meeting) => meeting.orgId === configOrgId() && meeting.projectId === projectId)
        .sort((a, b) => b.startedAt - a.startedAt);
    },
    async update(threadRef, patch) {
      if (!backing.update) throw new Error("meeting store requires DurableMap.update");
      let applied = false;
      const updated = await backing.update(threadRef, (meeting) => {
        if (meeting.orgId !== configOrgId() || meeting.status !== "open") return meeting;
        applied = true;
        return {
          ...meeting,
          ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
          ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
          updatedAt: Math.max(now(), meeting.updatedAt + 1),
        };
      });
      return updated && applied ? updated : null;
    },
    async end(threadRef, endedBy) {
      if (!backing.update) throw new Error("meeting store requires DurableMap.update");
      let changed = false;
      const updated = await backing.update(threadRef, (meeting) => {
        if (meeting.orgId !== configOrgId() || meeting.status !== "open") return meeting;
        changed = true;
        const at = Math.max(now(), meeting.updatedAt + 1);
        return { ...meeting, status: "ended", endedBy, endedAt: at, updatedAt: at };
      });
      const meeting = own(updated);
      return meeting ? { meeting, changed } : null;
    },
  };
}
