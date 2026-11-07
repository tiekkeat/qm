export * from "../agent/replay.ts";
export { zeroUsage } from "../model/model-runtime.ts";
import {
  reconstructMessagesFromHistory as reconstruct,
  recordedMessageTimestamps as timestamps,
} from "../agent/replay.ts";
import { nativeHistoryItem, type SessionEntry } from "./transcript.ts";
export const TURN_STOPPED_KIND = "turn_stopped";
export const WAKE_KIND = "wake";
export function reconstructMessagesFromHistory(
  history: readonly SessionEntry[],
  ...args: Tail<Parameters<typeof reconstruct>>
) {
  return reconstruct(history.map(nativeHistoryItem), ...args);
}
export function recordedMessageTimestamps(history: readonly SessionEntry[]) {
  return timestamps(history.map(nativeHistoryItem));
}
type Tail<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never;
