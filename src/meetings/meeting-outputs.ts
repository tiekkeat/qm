export const MEETING_OUTPUTS = ["minutes", "action_plan", "tasks"] as const;
export type MeetingOutput = (typeof MEETING_OUTPUTS)[number];

const OUTPUT_SPECS: Record<MeetingOutput, { file: string; label: string; brief: string }> = {
  minutes: {
    file: "minutes.md",
    label: "meeting minutes",
    brief: "who took part, the topics discussed, each decision with its reasoning, and the questions left open",
  },
  action_plan: {
    file: "action-plan.md",
    label: "action plan",
    brief:
      "the steps that carry out what was decided, in order, naming for each step the risk to anything already in production",
  },
  tasks: {
    file: "tasks.md",
    label: "task checklist",
    brief:
      "a markdown checklist with one `- [ ] task` line per task, giving the owner and due date when the meeting named them and leaving them blank when it did not",
  },
};

export function isMeetingOutput(value: unknown): value is MeetingOutput {
  return MEETING_OUTPUTS.includes(value as MeetingOutput);
}

export function meetingOutputsFolder(sessionId: string, endedAt: number): string {
  return `meetings/${new Date(endedAt).toISOString().slice(0, 10)}-${sessionId.slice(0, 8)}`;
}

export function meetingOutputsRequest(
  outputs: readonly MeetingOutput[],
  folder: string,
): { text: string; display: string } {
  const chosen = MEETING_OUTPUTS.filter((output) => outputs.includes(output)).map((output) => OUTPUT_SPECS[output]);
  return {
    display: `Generate from this meeting: ${chosen.map((spec) => spec.label).join(", ")}.`,
    text: [
      "The meeting above has ended. Write the documents below from that discussion and save each one with the files tool.",
      ...chosen.map((spec) => `- \`${folder}/${spec.file}\`: the ${spec.label}, covering ${spec.brief}.`),
      "Record only what the members actually said and decided. Write in the language the members used.",
      "Do not change anything else in the project. Finish with a short summary and the saved paths.",
    ].join("\n"),
  };
}
