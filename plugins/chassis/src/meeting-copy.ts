export const MEETING_MODES = ["mention", "judged", "off"] as const;
export type MeetingMode = (typeof MEETING_MODES)[number];

export const MEETING_OUTPUTS = ["minutes", "action_plan", "tasks"] as const;
export type MeetingOutput = (typeof MEETING_OUTPUTS)[number];

export const DEFAULT_MEETING_PROMPT = [
  "You are the moderator of this project meeting.",
  "Ground every suggestion in what this project already has: its files, documents, architecture, memory, and deployed apps.",
  "Combine the members' ideas into feasible plans that do not break anything already running in production.",
  "If a proposal would break a production app or require a major architecture change, say so plainly and repeat the warning until the members acknowledge it.",
].join("\n");
