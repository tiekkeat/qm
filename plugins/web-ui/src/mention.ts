const MENTION_TOKEN = /(^|\s)@([^\s@]*)$/;

export interface MentionCandidate {
  name: string;
  assistant: boolean;
}

export function mentionQuery(draft: string): string | null {
  const m = MENTION_TOKEN.exec(draft);
  return m ? (m[2] ?? "") : null;
}

export function insertMention(draft: string, name: string): string {
  return draft.replace(MENTION_TOKEN, (_m, pre: string) => `${pre}@${name} `);
}

export function mentionChoices(
  assistant: string | null,
  members: readonly string[],
  query: string,
): MentionCandidate[] {
  const needle = query.trim().toLowerCase();
  const seen = new Set<string>();
  const all: MentionCandidate[] = [];
  for (const candidate of [
    ...(assistant ? [{ name: assistant, assistant: true }] : []),
    ...members.map((name) => ({ name, assistant: false })),
  ]) {
    const key = candidate.name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    all.push(candidate);
  }
  return all.filter((candidate) => candidate.name.toLowerCase().includes(needle));
}

export function carriesMention(text: string, name: string): boolean {
  return text.includes(`@${name}`);
}
