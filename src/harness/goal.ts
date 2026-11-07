export * from "../agent/goal.ts";
import { goalWorkDigest } from "../agent/goal.ts";
import type { SessionEntry } from "./transcript.ts";
export function goalWorkFromEntries(entries: readonly Pick<SessionEntry, "type" | "payload">[]): string {
  return goalWorkDigest(
    entries.map((entry) => {
      const payload =
        entry.payload && typeof entry.payload === "object" ? (entry.payload as Record<string, unknown>) : {};
      const { wire: _wire, ...body } = payload;
      return `${entry.type}: ${typeof payload.text === "string" ? payload.text : JSON.stringify(body)}`;
    }),
  );
}
