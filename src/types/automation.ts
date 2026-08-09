export type AutomationSchedule =
  | { kind: 'interval'; every_minutes: number }
  | { kind: 'daily'; hour: number; minute: number };

export interface Automation {
  automation_id: string;
  flow_id: string;
  name: string;
  schedule: AutomationSchedule;
  enabled: boolean;
  /**
   * Must be explicitly opted into at creation time — see src/background/automations.ts
   * `canSchedule`. A flow with a `high` risk step can never be scheduled regardless of
   * this flag; a flow with only `medium` checkpoints requires it to be true.
   */
  auto_approve_checkpoints: boolean;
  created_at: string;
}

export type AutomationRunStatus = 'ok' | 'error' | 'skipped';

export interface AutomationRun {
  automation_id: string;
  at: string;
  status: AutomationRunStatus;
  message?: string;
}
