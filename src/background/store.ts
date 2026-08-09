/**
 * Local persistence. chrome.storage.local only — nothing leaves the machine, which is the
 * whole point of the local-first MVP. Swap this module to add a sync backend later; nothing
 * else in the extension touches storage.
 */
import type { RecordingSession } from '../types/capture';
import type { FlowDocument } from '../types/flow';
import type { SavedFlowSummary } from '../shared/messages';

const SESSION_KEY = 'eeveon_flow_active_session';
const FLOW_PREFIX = 'eeveon_flow_doc_';
const INDEX_KEY = 'eeveon_flow_index';

export async function readSession(): Promise<RecordingSession | null> {
  const bag = await chrome.storage.local.get(SESSION_KEY);
  return (bag[SESSION_KEY] as RecordingSession | undefined) ?? null;
}

export async function writeSession(session: RecordingSession | null): Promise<void> {
  if (session === null) {
    await chrome.storage.local.remove(SESSION_KEY);
    return;
  }
  await chrome.storage.local.set({ [SESSION_KEY]: session });
}

export async function saveFlow(flow: FlowDocument): Promise<void> {
  const index = await readIndex();
  const summary: SavedFlowSummary = {
    flow_id: flow.flow_id,
    name: flow.name,
    created_at: flow.created_at,
    step_count: flow.steps.length,
    host: flow.origin.host,
  };
  const next = [summary, ...index.filter((entry) => entry.flow_id !== flow.flow_id)];
  await chrome.storage.local.set({
    [FLOW_PREFIX + flow.flow_id]: flow,
    [INDEX_KEY]: next,
  });
}

export async function readIndex(): Promise<SavedFlowSummary[]> {
  const bag = await chrome.storage.local.get(INDEX_KEY);
  return (bag[INDEX_KEY] as SavedFlowSummary[] | undefined) ?? [];
}

export async function readFlow(flowId: string): Promise<FlowDocument | null> {
  const key = FLOW_PREFIX + flowId;
  const bag = await chrome.storage.local.get(key);
  return (bag[key] as FlowDocument | undefined) ?? null;
}

export async function deleteFlow(flowId: string): Promise<void> {
  const index = await readIndex();
  await chrome.storage.local.remove(FLOW_PREFIX + flowId);
  await chrome.storage.local.set({ [INDEX_KEY]: index.filter((e) => e.flow_id !== flowId) });
}

export async function renameFlow(flowId: string, name: string): Promise<void> {
  const flow = await readFlow(flowId);
  if (!flow) return;
  flow.name = name;
  await saveFlow(flow);
}
