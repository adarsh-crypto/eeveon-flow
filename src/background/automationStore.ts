/**
 * Persistence for automations and their run history. chrome.storage.local, parallel to
 * src/background/store.ts's flow persistence — automations reference flows by id but live
 * in their own keyspace so deleting a flow doesn't have to know about automations (the
 * scheduler checks for a missing flow at run time instead, see automations.ts).
 */
import type { Automation, AutomationRun } from '../types/automation';

const AUTOMATIONS_KEY = 'eeveon_flow_automations';
const RUNS_PREFIX = 'eeveon_flow_automation_runs_';
const MAX_RUNS_PER_AUTOMATION = 20;

export async function listAutomations(): Promise<Automation[]> {
  const bag = await chrome.storage.local.get(AUTOMATIONS_KEY);
  return (bag[AUTOMATIONS_KEY] as Automation[] | undefined) ?? [];
}

export async function getAutomation(id: string): Promise<Automation | null> {
  const automations = await listAutomations();
  return automations.find((a) => a.automation_id === id) ?? null;
}

export async function saveAutomation(automation: Automation): Promise<void> {
  const automations = await listAutomations();
  const next = [automation, ...automations.filter((a) => a.automation_id !== automation.automation_id)];
  await chrome.storage.local.set({ [AUTOMATIONS_KEY]: next });
}

export async function deleteAutomation(id: string): Promise<void> {
  const automations = await listAutomations();
  await chrome.storage.local.set({
    [AUTOMATIONS_KEY]: automations.filter((a) => a.automation_id !== id),
  });
  await chrome.storage.local.remove(RUNS_PREFIX + id);
}

export async function recordRun(run: AutomationRun): Promise<void> {
  const key = RUNS_PREFIX + run.automation_id;
  const bag = await chrome.storage.local.get(key);
  const existing = (bag[key] as AutomationRun[] | undefined) ?? [];
  const next = [run, ...existing].slice(0, MAX_RUNS_PER_AUTOMATION);
  await chrome.storage.local.set({ [key]: next });
}

export async function listRuns(automationId: string): Promise<AutomationRun[]> {
  const key = RUNS_PREFIX + automationId;
  const bag = await chrome.storage.local.get(key);
  return (bag[key] as AutomationRun[] | undefined) ?? [];
}
