import type { DeploymentView } from "./deploy-view";

export type Release = NonNullable<DeploymentView["versions"]>[number];
export type DetailTab = "overview" | "versions" | "github" | "settings";
export type Mode =
  | "connect"
  | "setup"
  | "create"
  | "link"
  | "submit"
  | "import"
  | "invite"
  | "rollback"
  | "edit"
  | "unlink"
  | "remove-access";
export interface Change {
  path: string;
  sha?: string | null;
  before?: string | null;
  after?: string | null;
}
export interface Operation {
  id: string;
  actor: string;
  action?: string;
  input?: Record<string, unknown>;
  result?: unknown;
  branch?: string;
  commit?: string;
  release?: number;
  pr?: {
    html_url: string;
    number: number;
    state: string;
    merged_at: string | null;
    user: { login: string };
    head: { ref: string };
    base: { ref: string };
  };
  invitation?: { username: string; granted: boolean; removedAt?: number };
}
export interface Collaboration {
  actorId?: string;
  oauthConfigured?: boolean;
  identity?: { login: string };
  link?: { repository: string; base: string; directory: string; unlinkedAt?: number };
  canConfigure: boolean;
  qmAccess: string;
  githubAccess: string;
  error?: string;
  operations: Operation[];
}
export interface Preview {
  changes: Change[];
  expectedSha: string;
  expectedVersion: number;
  otherPublishers?: string[];
  replacesNewerChanges?: boolean;
  identity?: { login: string; id: number };
}
type ReadKind = "connection" | "release" | "preview" | "diff";
export class CollaborationState {
  collaboration?: Collaboration;
  lastChecked?: number;
  tab: DetailTab = "overview";
  mode?: Mode;
  draft: Record<string, unknown> = {};
  preview?: Preview;
  release?: Release;
  changes?: Change[];
  submittedChanges?: Change[];
  events?: Array<{ actor: string; outcome: string; kind: string; at: number }>;
  comparison = "";
  actionId?: string;
  submissionId?: string;
  opener: HTMLElement | null = null;
  pending?: string;
  error?: string;
  reads: Partial<Record<ReadKind, AbortController>> = {};
  errors: Partial<Record<ReadKind, string>> = {};
  revision = 0;
  private readonly readTimeout: number;
  constructor(readTimeout = 20_000) {
    this.readTimeout = readTimeout;
  }
  get linked() {
    return this.collaboration?.link?.unlinkedAt ? undefined : this.collaboration?.link;
  }
  async read<T>(
    kind: ReadKind,
    task: (signal: AbortSignal) => Promise<T>,
    apply: (value: T) => void,
    redraw: () => void,
  ) {
    this.reads[kind]?.abort();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(this.readTimeout)]);
    this.reads[kind] = controller;
    delete this.errors[kind];
    redraw();
    let aborted: (() => void) | undefined;
    try {
      const result = await Promise.race([
        task(signal),
        new Promise<never>((_, reject) => {
          aborted = () => reject(signal.reason);
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        }),
      ]);
      if (this.reads[kind] === controller && !signal.aborted) apply(result);
    } catch (error) {
      if (this.reads[kind] === controller && !controller.signal.aborted)
        this.errors[kind] = error instanceof Error ? error.message : "Could not load. Please retry.";
      if (this.reads[kind] === controller && !controller.signal.aborted && signal.aborted)
        this.errors[kind] = "This check took too long. Please retry.";
    } finally {
      if (aborted) signal.removeEventListener("abort", aborted);
      if (this.reads[kind] === controller) {
        delete this.reads[kind];
        redraw();
      }
    }
  }
  cancelReads() {
    Object.values(this.reads).forEach((controller) => controller?.abort());
    this.reads = {};
  }
  change(name: string, value: unknown) {
    if (this.pending) return;
    this.draft = { ...this.draft, [name]: value };
    this.preview = undefined;
    delete this.errors.preview;
    this.actionId = undefined;
    this.error = undefined;
    this.revision++;
    this.reads.preview?.abort();
  }
  start(mode: Mode, draft: Record<string, unknown> = {}) {
    if (this.pending) return;
    this.reads.preview?.abort();
    this.mode = mode;
    this.draft = draft;
    this.preview = undefined;
    delete this.errors.preview;
    this.actionId = undefined;
    this.error = undefined;
    this.revision++;
  }
  async mutate(label: string, task: () => Promise<void>, redraw: () => void) {
    if (this.pending) return false;
    this.pending = label;
    this.error = undefined;
    redraw();
    try {
      await task();
      return true;
    } catch (error) {
      this.error = error instanceof Error ? error.message : "Action failed. Please retry.";
      return false;
    } finally {
      this.pending = undefined;
      redraw();
    }
  }
}

export function connectionLabel(s: CollaborationState): string {
  const c = s.collaboration;
  if (!c) return s.errors.connection ? "Check failed" : "Checking connection";
  if (s.errors.connection || c.error) {
    if (/expired|revoked|reconnect/i.test(c.error ?? "")) return "Reconnect required";
    if (c.githubAccess === "GitHub not connected" && /not connected/i.test(c.error ?? "")) return "Not connected";
    if (c.githubAccess === "Invitation pending" && c.identity) return `Connected as ${c.identity.login}`;
    return "Check failed";
  }
  return c.identity ? `Connected as ${c.identity.login}` : "Not connected";
}
