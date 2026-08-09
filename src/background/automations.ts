/**
 * Scheduling — chrome.alarms wakes the (possibly-killed) service worker on schedule, which
 * opens the flow's origin in a tab and runs it through the existing replay engine
 * (src/background/replay.ts). No changes to how a step executes; the only new behavior
 * replay.ts gained for this is `auto_approve_checkpoints`, so an automation can pass its
 * checkpoints without a human present to click Approve.
 *
 * chrome.alarms, not setInterval: an MV3 service worker is routinely killed when idle, and
 * a setInterval timer dies with it. Alarms are durable — they survive the worker being
 * killed and even a full browser restart, firing onAlarm exactly when due.
 */
import type { FlowDocument } from '../types/flow';
import type { Automation, AutomationRun, AutomationSchedule } from '../types/automation';
import * as flowStore from './store';
import * as automationStore from './automationStore';
import * as vault from './vault';
import * as replay from './replay';

const RUN_POLL_MS = 300;
const RUN_TIMEOUT_MS = 5 * 60_000;

export interface ScheduleCheck {
  ok: boolean;
  reason: string | null;
}

/**
 * Decided once at creation time (and re-checked at run time, in case the flow changed
 * since): a flow with a `high` risk step can never be scheduled — that risk tier already
 * means "credential entry or a destructive action," and running that unattended is exactly
 * the case worth refusing outright. A flow with only `medium` checkpoints is schedulable
 * only if the caller has explicitly opted into auto-approving them. Every required secret
 * variable must already have a vault entry, or there'd be nothing to type in at run time.
 */
export async function canSchedule(flow: FlowDocument, autoApproveCheckpoints: boolean): Promise<ScheduleCheck> {
  if (flow.steps.some((step) => step.risk === 'high')) {
    return { ok: false, reason: 'this flow has a high-risk step (credential entry or a destructive action) — it can never be scheduled' };
  }

  if (flow.checkpoints.length > 0 && !autoApproveCheckpoints) {
    return {
      ok: false,
      reason: 'this flow has approval checkpoints — scheduling it requires explicitly auto-approving them',
    };
  }

  for (const variable of flow.variables) {
    if (variable.kind !== 'secret') continue;
    const stored = await vault.hasSecret(flow.flow_id, variable.name);
    if (!stored) {
      return { ok: false, reason: `no vault entry for required secret "${variable.label}" — add it before scheduling` };
    }
  }

  return { ok: true, reason: null };
}

export interface CreateAutomationInput {
  flow_id: string;
  name: string;
  schedule: AutomationSchedule;
  auto_approve_checkpoints: boolean;
}

export async function createAutomation(input: CreateAutomationInput): Promise<Automation> {
  const flow = await flowStore.readFlow(input.flow_id);
  if (!flow) throw new Error('flow not found');

  const check = await canSchedule(flow, input.auto_approve_checkpoints);
  if (!check.ok) throw new Error(check.reason ?? 'flow cannot be scheduled');

  const automation: Automation = {
    automation_id: crypto.randomUUID(),
    flow_id: input.flow_id,
    name: input.name,
    schedule: input.schedule,
    enabled: true,
    auto_approve_checkpoints: input.auto_approve_checkpoints,
    created_at: new Date().toISOString(),
  };

  await automationStore.saveAutomation(automation);
  await chrome.alarms.create(automation.automation_id, alarmInfoFor(automation.schedule));
  return automation;
}

export async function setAutomationEnabled(automationId: string, enabled: boolean): Promise<Automation> {
  const automation = await automationStore.getAutomation(automationId);
  if (!automation) throw new Error('automation not found');

  automation.enabled = enabled;
  await automationStore.saveAutomation(automation);

  if (enabled) {
    await chrome.alarms.create(automationId, alarmInfoFor(automation.schedule));
  } else {
    await chrome.alarms.clear(automationId);
  }
  return automation;
}

export async function deleteAutomation(automationId: string): Promise<void> {
  await chrome.alarms.clear(automationId);
  await automationStore.deleteAutomation(automationId);
}

export async function listAutomations(): Promise<Automation[]> {
  return automationStore.listAutomations();
}

export async function listRuns(automationId: string): Promise<AutomationRun[]> {
  return automationStore.listRuns(automationId);
}

function alarmInfoFor(schedule: AutomationSchedule): chrome.alarms.AlarmCreateInfo {
  if (schedule.kind === 'interval') {
    return { periodInMinutes: Math.max(1, schedule.every_minutes) };
  }
  return { when: nextDailyOccurrence(schedule.hour, schedule.minute), periodInMinutes: 24 * 60 };
}

function nextDailyOccurrence(hour: number, minute: number): number {
  const next = new Date();
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.getTime();
}

/** Re-registers every enabled automation's alarm. Call on extension startup — alarms
 *  persist across restarts on their own, but this guards against a version that changes
 *  how an alarm's timing is computed. */
export async function reconcileAlarms(): Promise<void> {
  const automations = await automationStore.listAutomations();
  for (const automation of automations) {
    if (!automation.enabled) continue;
    const existing = await chrome.alarms.get(automation.automation_id);
    if (!existing) await chrome.alarms.create(automation.automation_id, alarmInfoFor(automation.schedule));
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  void runAutomation(alarm.name);
});

async function runAutomation(automationId: string): Promise<void> {
  const automation = await automationStore.getAutomation(automationId);
  if (!automation || !automation.enabled) return;

  const flow = await flowStore.readFlow(automation.flow_id);
  if (!flow) {
    await finish(automation, 'skipped', 'the flow this automation points at no longer exists');
    await setAutomationEnabled(automationId, false);
    return;
  }

  const check = await canSchedule(flow, automation.auto_approve_checkpoints);
  if (!check.ok) {
    await finish(automation, 'skipped', check.reason ?? 'flow can no longer be scheduled');
    return;
  }

  const variables: Record<string, string> = {};
  for (const variable of flow.variables) {
    if (variable.kind === 'secret') {
      const secret = await vault.readSecret(flow.flow_id, variable.name);
      if (secret === null) {
        await finish(automation, 'skipped', `no vault entry for "${variable.label}"`);
        return;
      }
      variables[variable.name] = secret;
    } else {
      variables[variable.name] = variable.default ?? '';
    }
  }

  const tab = await chrome.tabs.create({ url: flow.origin.url, active: false });
  if (tab.id === undefined) {
    await finish(automation, 'error', 'could not open a tab to run against');
    return;
  }

  try {
    await replay.startReplay({
      flow_id: flow.flow_id,
      tab_id: tab.id,
      variables,
      pace_ms: 0, // nobody is watching this run happen
      auto_approve_checkpoints: automation.auto_approve_checkpoints,
    });
  } catch (error) {
    await finish(automation, 'error', error instanceof Error ? error.message : String(error));
    return;
  }

  const finalState = await waitForCompletion();
  if (!finalState) {
    await finish(automation, 'error', 'timed out waiting for the run to finish');
    return;
  }

  if (finalState.status === 'done') {
    await finish(automation, 'ok');
    await chrome.tabs.remove(tab.id).catch(() => undefined);
  } else {
    // 'error', 'stopped', or an unexpected 'paused-approval' (shouldn't happen given the
    // canSchedule gate, but a flow re-recorded between the gate check and this run could
    // theoretically add a checkpoint auto_approve_checkpoints doesn't cover yet).
    await finish(automation, 'error', finalState.error ?? `run ended as "${finalState.status}"`);
  }
}

async function waitForCompletion() {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await replay.getReplayStatus();
    // paused-approval is a terminal state here too: canSchedule already refuses anything
    // that should reach a checkpoint without auto_approve_checkpoints, so a run that still
    // lands here is a bug, not something to sit and wait out for five minutes.
    if (state && state.status !== 'running') {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, RUN_POLL_MS));
  }
  return null;
}

async function finish(automation: Automation, status: AutomationRun['status'], message?: string): Promise<void> {
  await automationStore.recordRun({ automation_id: automation.automation_id, at: new Date().toISOString(), status, message });
  if (status !== 'ok') {
    try {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title: `Automation "${automation.name}" ${status === 'skipped' ? 'skipped' : 'failed'}`,
        message: message ?? 'no further detail',
      });
    } catch {
      // Notifications are best-effort; the run's outcome is already recorded either way.
    }
  }
}
