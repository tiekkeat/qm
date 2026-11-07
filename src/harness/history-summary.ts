import { summarizeHistory as summarize } from "../agent/history-summary.ts";
import { nativeHistoryItem, type SessionEntry } from "./transcript.ts";
export function summarizeHistory(history: SessionEntry[], ...args: Tail<Parameters<typeof summarize>>) {
  return summarize(history.map(nativeHistoryItem), ...args);
}
type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never;
