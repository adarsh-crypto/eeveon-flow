/** Message contract between content script, service worker, and side panel. */
import type { RawEvent } from '../types/capture';
import type { FlowDocument } from '../types/flow';
import type { ReplayActionPayload, StepResult } from '../replay/actionPayload';
import type { ReplayState } from '../types/replay';

export interface RecordingStatus {
  recording: boolean;
  session_id: string | null;
  tab_id: number | null;
  event_count: number;
  started_at: number | null;
  origin_host: string | null;
}

export interface SavedFlowSummary {
  flow_id: string;
  name: string;
  created_at: string;
  step_count: number;
  host: string;
}

export type Message =
  // content → worker
  | { kind: 'events'; events: RawEvent[] }
  | { kind: 'is-recording' }
  // panel → worker
  | { kind: 'start'; tab_id: number }
  | { kind: 'stop' }
  | { kind: 'status' }
  | { kind: 'list-flows' }
  | { kind: 'get-flow'; flow_id: string }
  | { kind: 'delete-flow'; flow_id: string }
  | { kind: 'rename-flow'; flow_id: string; name: string }
  | { kind: 'import-flow'; flow: unknown }
  // panel → worker: replay
  | { kind: 'run-flow'; flow_id: string; tab_id: number; variables: Record<string, string> }
  | { kind: 'replay-status' }
  | { kind: 'approve-checkpoint' }
  | { kind: 'reject-checkpoint' }
  | { kind: 'stop-replay' }
  // worker → content: replay
  | { kind: 'run-step'; payload: ReplayActionPayload };

export type Response =
  | { ok: true; status: RecordingStatus }
  | { ok: true; recording: boolean }
  | { ok: true; flow: FlowDocument }
  | { ok: true; flows: SavedFlowSummary[] }
  | { ok: true; replay: ReplayState | null }
  | { ok: true }
  | { ok: false; error: string };

/** The content script's reply to `run-step` is a bare StepResult, not the Response union. */
export type RunStepReply = StepResult;
