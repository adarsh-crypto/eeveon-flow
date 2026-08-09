/**
 * The orchestrator (src/background/replay.ts) against a fake `chrome`. What matters here
 * is the state machine — pause exactly at a checkpoint, resume exactly once past it, stop
 * cleanly on a failed step — not real DOM execution, which is execute-step's job and is
 * exercised through the browser instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileFlow } from '../src/compile/compileFlow';
import { searchSession, TEST_T0 } from './fixtures/search-recording';
import type { ReplayState } from '../src/types/replay';

const OPTIONS = { now: () => TEST_T0, idFactory: () => 'flow-fixed-id' };

interface FakeChrome {
  storage: {
    local: MemoryStore;
    session: MemoryStore;
  };
  tabs: {
    update: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    onUpdated: {
      addListener: (fn: (tabId: number, info: { status: string }) => void) => void;
      removeListener: (fn: (tabId: number, info: { status: string }) => void) => void;
    };
  };
}

interface MemoryStore {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (values: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
}

function memoryStore(): MemoryStore {
  const data: Record<string, unknown> = {};
  return {
    get: async (key: string) => ({ [key]: data[key] }),
    set: async (values: Record<string, unknown>) => {
      Object.assign(data, values);
    },
    remove: async (key: string) => {
      delete data[key];
    },
  };
}

/** `sendMessage` behaviour is per-test; each test installs its own via installChrome(). */
function installChrome(sendMessage: ReturnType<typeof vi.fn>): FakeChrome {
  const updateListeners: Array<(tabId: number, info: { status: string }) => void> = [];
  const fake: FakeChrome = {
    storage: { local: memoryStore(), session: memoryStore() },
    tabs: {
      update: vi.fn(async (tabId: number) => {
        // A real chrome.tabs.update() resolves once the navigation is *accepted*, well
        // before the page actually finishes loading — leaving plenty of time for the
        // caller to register its onUpdated listener. queueMicrotask would fire before
        // that registration and the notification would be lost to an empty listener
        // list, so this uses a real (if tiny) delay to preserve that ordering.
        setTimeout(() => updateListeners.forEach((listener) => listener(tabId, { status: 'complete' })), 5);
      }),
      sendMessage,
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: 'https://steamcharts.com/', title: 'Steam Charts' })),
      onUpdated: {
        addListener: (fn) => updateListeners.push(fn),
        removeListener: (fn) => {
          const i = updateListeners.indexOf(fn);
          if (i >= 0) updateListeners.splice(i, 1);
        },
      },
    },
  };
  vi.stubGlobal('chrome', fake);
  return fake;
}

async function waitUntil(predicate: (state: ReplayState | null) => boolean, getReplayStatus: () => Promise<ReplayState | null>) {
  for (let i = 0; i < 200; i += 1) {
    const state = await getReplayStatus();
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('waitUntil timed out');
}

describe('replay orchestrator', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('pauses exactly at the checkpoint and resumes exactly once past it on approval', async () => {
    installChrome(vi.fn(async () => ({ ok: true })));
    const store = await import('../src/background/store');
    const replay = await import('../src/background/replay');

    const flow = compileFlow(searchSession(), OPTIONS);
    await store.saveFlow(flow);

    const checkpointStep = flow.checkpoints[0]!.before_step;
    await replay.startReplay({ flow_id: flow.flow_id, tab_id: 1, variables: {}, pace_ms: 0 });

    const paused = await waitUntil((s) => s?.status === 'paused-approval', replay.getReplayStatus);
    expect(paused?.pending_checkpoint?.before_step).toBe(checkpointStep);
    // Paused *before* running the checkpointed step, not after.
    expect(flow.steps[paused!.step_index]?.step_id).toBe(checkpointStep);

    await replay.approveCheckpoint();
    const done = await waitUntil((s) => s?.status === 'done', replay.getReplayStatus);

    expect(done?.log).toHaveLength(flow.steps.length);
    expect(done?.log.every((entry) => entry.status === 'ok')).toBe(true);
    // The checkpointed step itself ran exactly once.
    expect(done?.log.filter((entry) => entry.step_id === checkpointStep)).toHaveLength(1);
  });

  it('stops without executing the step when the checkpoint is rejected', async () => {
    const sendMessage = vi.fn(async () => ({ ok: true }));
    installChrome(sendMessage);
    const store = await import('../src/background/store');
    const replay = await import('../src/background/replay');

    const flow = compileFlow(searchSession(), OPTIONS);
    await store.saveFlow(flow);

    await replay.startReplay({ flow_id: flow.flow_id, tab_id: 1, variables: {}, pace_ms: 0 });
    await waitUntil((s) => s?.status === 'paused-approval', replay.getReplayStatus);

    const callsBeforeReject = sendMessage.mock.calls.length;
    const rejected = await replay.rejectCheckpoint();

    expect(rejected.status).toBe('stopped');
    // Give any stray async work a tick, then confirm nothing further ran.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sendMessage.mock.calls.length).toBe(callsBeforeReject);
  });

  it('stops at the first failing step and does not advance past it', async () => {
    let calls = 0;
    installChrome(
      vi.fn(async () => {
        calls += 1;
        // Fail on the second content-script step (the type at index 2; index 0 is a
        // navigate handled without sendMessage, index 1's click is the first call).
        if (calls === 2) return { ok: false, error: 'selector not found' };
        return { ok: true };
      }),
    );
    const store = await import('../src/background/store');
    const replay = await import('../src/background/replay');

    const flow = compileFlow(searchSession(), OPTIONS);
    await store.saveFlow(flow);

    await replay.startReplay({ flow_id: flow.flow_id, tab_id: 1, variables: {}, pace_ms: 0 });
    const errored = await waitUntil((s) => s?.status === 'error', replay.getReplayStatus);

    expect(errored?.error).toContain('selector not found');
    expect(errored?.log.at(-1)?.status).toBe('error');
    // The failing step is not counted as advanced.
    expect(flow.steps[errored!.step_index]?.verb).toBe('type');
  });

  it('resolves a variable reference to its supplied run-time value, not its recorded default', async () => {
    const seen: string[] = [];
    installChrome(
      vi.fn(async (_tabId: number, message: { payload?: { verb: string; text: string | null } }) => {
        if (message.payload?.verb === 'type') seen.push(message.payload.text ?? '');
        return { ok: true };
      }),
    );
    const store = await import('../src/background/store');
    const replay = await import('../src/background/replay');

    const flow = compileFlow(searchSession(), OPTIONS);
    await store.saveFlow(flow);
    const variableName = flow.variables[0]!.name;

    await replay.startReplay({ flow_id: flow.flow_id, tab_id: 1, variables: { [variableName]: 'portal 2' }, pace_ms: 0 });
    await waitUntil((s) => s?.status === 'paused-approval', replay.getReplayStatus);

    expect(seen).toEqual(['portal 2']);
  });

  it('refuses to start a second replay while one is already running', async () => {
    installChrome(vi.fn(async () => new Promise(() => undefined))); // never resolves
    const store = await import('../src/background/store');
    const replay = await import('../src/background/replay');

    const flow = compileFlow(searchSession(), OPTIONS);
    await store.saveFlow(flow);

    await replay.startReplay({ flow_id: flow.flow_id, tab_id: 1, variables: {}, pace_ms: 0 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(replay.startReplay({ flow_id: flow.flow_id, tab_id: 1, variables: {} })).rejects.toThrow(
      /already running/,
    );
  });
});
