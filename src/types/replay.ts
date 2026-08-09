export type ReplayStatus = 'running' | 'paused-approval' | 'done' | 'error' | 'stopped';

export interface ReplayLogEntry {
  step_id: string;
  status: 'ok' | 'error' | 'skipped';
  message?: string;
  at: number;
}

export interface PendingCheckpoint {
  checkpoint_id: string;
  before_step: string;
  reason: string;
  severity: 'medium' | 'high';
}

export interface ReplayState {
  flow_id: string;
  tab_id: number;
  /** Index of the step about to run (or that just paused before running). */
  step_index: number;
  status: ReplayStatus;
  /**
   * Values a user supplied at run time. Held only in chrome.storage.session (memory-only,
   * cleared on browser close) — never written to the same store as saved Flow JSON, so a
   * secret entered here can never end up inside an exported artifact.
   */
  variables: Record<string, string>;
  log: ReplayLogEntry[];
  error: string | null;
  pending_checkpoint: PendingCheckpoint | null;
  /** Pause after each non-navigate step, so a human watching the tab can follow along. */
  step_pace_ms: number;
}
