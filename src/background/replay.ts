/**
 * Replay orchestrator — runs in the service worker.
 *
 * Steps execute one at a time, in order. A `navigate` step is performed here directly
 * (chrome.tabs.update); every other verb is delegated to the content script, which is the
 * only context with DOM access. Execution pauses before any step guarded by a checkpoint
 * and waits for an explicit approve/reject from the side panel — that pause is the whole
 * point of the risk model in compile/risk.ts.
 *
 * Known limitation: an MV3 service worker can be killed after ~30s with no pending
 * extension-API call in flight. A long `wait` step or a slow page can in theory stall a
 * run. Acceptable for this MVP; a keepalive alarm would close the gap if it becomes a
 * problem in practice.
 */
import type { FlowDocument, FlowStep, Value } from '../types/flow';
import type { ReplayActionPayload, StepResult } from '../replay/actionPayload';
import type { PendingCheckpoint, ReplayState } from '../types/replay';
import * as flowStore from './store';
import * as replayStore from './replayStore';

const STEP_TIMEOUT_MS = 10_000;
const NAVIGATE_TIMEOUT_MS = 20_000;

/**
 * A deliberate pause after each non-navigate step, so a human watching the tab can see
 * each action land before the next one fires. Without this the replay finishes a whole
 * recording faster than the eye can follow, which reads as broken even when every step
 * succeeded. `navigate` already takes real page-load time and gets no extra pause.
 */
const STEP_PACE_MS = 900;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StartReplayInput {
  flow_id: string;
  tab_id: number;
  variables: Record<string, string>;
  /** Test-only override for STEP_PACE_MS. Production callers never set this. */
  pace_ms?: number;
}

export async function startReplay(input: StartReplayInput): Promise<ReplayState> {
  const existing = await replayStore.readReplayState();
  if (existing && existing.status !== 'done' && existing.status !== 'error' && existing.status !== 'stopped') {
    throw new Error('a replay is already running');
  }

  const flow = await flowStore.readFlow(input.flow_id);
  if (!flow) throw new Error('flow not found');

  const state: ReplayState = {
    flow_id: input.flow_id,
    tab_id: input.tab_id,
    step_index: 0,
    status: 'running',
    variables: input.variables,
    log: [],
    error: null,
    pending_checkpoint: null,
    step_pace_ms: input.pace_ms ?? STEP_PACE_MS,
  };
  await replayStore.writeReplayState(state);
  void run(flow, { skipCheckpointOnce: false }); // fire and forget; caller polls status
  return state;
}

export async function approveCheckpoint(): Promise<ReplayState> {
  const state = await replayStore.readReplayState();
  if (!state || state.status !== 'paused-approval') {
    throw new Error('no checkpoint is awaiting approval');
  }
  const flow = await flowStore.readFlow(state.flow_id);
  if (!flow) throw new Error('flow not found');

  state.status = 'running';
  state.pending_checkpoint = null;
  await replayStore.writeReplayState(state);
  // The step at state.step_index is the one that was just approved — run() must execute
  // it without re-checking its checkpoint, or an approved step re-pauses itself forever.
  void run(flow, { skipCheckpointOnce: true });
  return state;
}

export async function rejectCheckpoint(): Promise<ReplayState> {
  const state = await replayStore.readReplayState();
  if (!state || state.status !== 'paused-approval') {
    throw new Error('no checkpoint is awaiting approval');
  }
  state.status = 'stopped';
  state.pending_checkpoint = null;
  await replayStore.writeReplayState(state);
  return state;
}

export async function stopReplay(): Promise<ReplayState> {
  const state = await replayStore.readReplayState();
  if (!state) throw new Error('nothing is running');
  state.status = 'stopped';
  await replayStore.writeReplayState(state);
  return state;
}

export async function getReplayStatus(): Promise<ReplayState | null> {
  return replayStore.readReplayState();
}

interface RunOptions {
  /**
   * True only for the single loop iteration right after an approval: the step at
   * step_index already has its go-ahead, so its checkpoint must not be re-evaluated (the
   * checkpoint's own state was already cleared to null by approveCheckpoint). Every
   * later iteration checks checkpoints normally.
   */
  skipCheckpointOnce: boolean;
}

/** The main loop. Re-entered after every approval; exits on pause, done, error, or stop. */
async function run(flow: FlowDocument, options: RunOptions): Promise<void> {
  let skipCheckpointOnce = options.skipCheckpointOnce;

  for (;;) {
    const state = await replayStore.readReplayState();
    if (!state || state.status !== 'running') return;

    if (state.step_index >= flow.steps.length) {
      state.status = 'done';
      await replayStore.writeReplayState(state);
      return;
    }

    const step = flow.steps[state.step_index]!;
    const checkpoint = flow.checkpoints.find((c) => c.before_step === step.step_id);
    if (checkpoint && !skipCheckpointOnce) {
      state.status = 'paused-approval';
      state.pending_checkpoint = toPending(checkpoint);
      await replayStore.writeReplayState(state);
      return;
    }
    skipCheckpointOnce = false;

    const result = await runStep(state, step);
    state.log.push({
      step_id: step.step_id,
      status: result.ok ? 'ok' : 'error',
      message: result.ok ? undefined : result.error,
      at: Date.now(),
    });

    if (!result.ok) {
      state.status = 'error';
      state.error = `step ${step.index + 1} (${step.verb}) failed: ${result.error ?? 'unknown error'}`;
      await replayStore.writeReplayState(state);
      return;
    }

    state.step_index += 1;
    await replayStore.writeReplayState(state);

    if (step.verb !== 'navigate' && state.step_pace_ms > 0) {
      await sleep(state.step_pace_ms);
    }
  }
}

function toPending(checkpoint: FlowDocument['checkpoints'][number]): PendingCheckpoint {
  return {
    checkpoint_id: checkpoint.checkpoint_id,
    before_step: checkpoint.before_step,
    reason: checkpoint.reason,
    severity: checkpoint.severity,
  };
}

async function runStep(state: ReplayState, step: FlowStep): Promise<StepResult> {
  if (step.verb === 'navigate') {
    return runNavigate(state.tab_id, step.url);
  }
  const payload: ReplayActionPayload = {
    step_id: step.step_id,
    verb: step.verb,
    target: step.target,
    text: resolveValue(step.value, state.variables),
    url: step.url,
  };
  return sendToContent(state.tab_id, payload);
}

function resolveValue(value: Value | null, variables: Record<string, string>): string | null {
  if (!value) return null;
  if (value.kind === 'literal') return value.text;
  const supplied = variables[value.variable];
  return supplied ?? '';
}

async function runNavigate(tabId: number, url: string | null): Promise<StepResult> {
  if (!url) return { ok: false, error: 'navigate step has no url' };
  try {
    await chrome.tabs.update(tabId, { url });
    await waitForTabComplete(tabId);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function waitForTabComplete(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('navigation timed out'));
    }, NAVIGATE_TIMEOUT_MS);

    function listener(updatedTabId: number, info: chrome.tabs.TabChangeInfo): void {
      if (updatedTabId !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function sendToContent(tabId: number, payload: ReplayActionPayload): Promise<StepResult> {
  const timeout = new Promise<StepResult>((resolve) => {
    setTimeout(() => resolve({ ok: false, error: 'content script did not respond in time' }), STEP_TIMEOUT_MS);
  });
  const send = chrome.tabs
    .sendMessage(tabId, { kind: 'run-step', payload })
    .then((response: StepResult | undefined) => response ?? { ok: false, error: 'no response from page' })
    .catch((error: unknown) => ({
      ok: false,
      error: `could not reach the page: ${error instanceof Error ? error.message : String(error)}`,
    }));
  return Promise.race([send, timeout]);
}
