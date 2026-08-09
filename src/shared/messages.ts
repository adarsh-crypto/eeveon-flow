/** Message contract between content script, service worker, and side panel. */
import type { RawEvent } from '../types/capture';
import type { FlowDocument } from '../types/flow';
import type { ReplayActionPayload, StepResult } from '../replay/actionPayload';
import type { ReplayState } from '../types/replay';
import type { Automation, AutomationRun, AutomationSchedule } from '../types/automation';

export interface VaultEntryMeta {
  flow_id: string;
  variable: string;
  created_at: string;
}

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
  // panel/dashboard → worker: vault
  | { kind: 'vault-list' }
  | { kind: 'vault-store-secret'; flow_id: string; variable: string; value: string }
  | { kind: 'vault-delete-secret'; flow_id: string; variable: string }
  // panel/dashboard → worker: automations
  | { kind: 'automation-can-schedule'; flow_id: string; auto_approve_checkpoints: boolean }
  | {
      kind: 'automation-create';
      flow_id: string;
      name: string;
      schedule: AutomationSchedule;
      auto_approve_checkpoints: boolean;
    }
  | { kind: 'automation-set-enabled'; automation_id: string; enabled: boolean }
  | { kind: 'automation-delete'; automation_id: string }
  | { kind: 'automation-list' }
  | { kind: 'automation-list-runs'; automation_id: string }
  // worker → content: replay
  | { kind: 'run-step'; payload: ReplayActionPayload };

export type Response =
  | { ok: true; status: RecordingStatus }
  | { ok: true; recording: boolean }
  | { ok: true; flow: FlowDocument }
  | { ok: true; flows: SavedFlowSummary[] }
  | { ok: true; replay: ReplayState | null }
  | { ok: true; entries: VaultEntryMeta[] }
  | { ok: true; can_schedule: boolean; reason: string | null }
  | { ok: true; automation: Automation }
  | { ok: true; automations: Automation[] }
  | { ok: true; runs: AutomationRun[] }
  | { ok: true }
  | { ok: false; error: string };

/** The content script's reply to `run-step` is a bare StepResult, not the Response union. */
export type RunStepReply = StepResult;
