/**
 * src/background/automations.ts against a fake chrome. Covers the risk/vault gating in
 * canSchedule(), the schedule → alarm math, and the full onAlarm → runAutomation pipeline
 * (fired by invoking the captured chrome.alarms.onAlarm listener directly, since
 * runAutomation itself is private by design — the alarm is its only entry point).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compileFlow } from '../src/compile/compileFlow';
import { searchSession, passwordBox, TEST_T0 } from './fixtures/search-recording';
import type { RecordingSession } from '../src/types/capture';

const OPTIONS = { now: () => TEST_T0, idFactory: () => 'flow-fixed-id' };

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

interface AlarmRecord {
  name: string;
  info: chrome.alarms.AlarmCreateInfo;
}

function installChrome(sendMessage: ReturnType<typeof vi.fn>) {
  const updateListeners: Array<(tabId: number, info: { status: string }) => void> = [];
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const alarms = new Map<string, AlarmRecord>();
  const createdTabs: number[] = [];
  const removedTabs: number[] = [];
  const notifications = vi.fn();
  let nextTabId = 100;

  const fake = {
    storage: { local: memoryStore(), session: memoryStore() },
    tabs: {
      create: vi.fn(async (_props: { url: string; active?: boolean }) => {
        const id = nextTabId++;
        createdTabs.push(id);
        return { id };
      }),
      remove: vi.fn(async (tabId: number) => {
        removedTabs.push(tabId);
      }),
      update: vi.fn(async (tabId: number) => {
        setTimeout(() => updateListeners.forEach((l) => l(tabId, { status: 'complete' })), 5);
      }),
      sendMessage,
      get: vi.fn(async (tabId: number) => ({ id: tabId, url: 'https://steamcharts.com/', title: 'Steam Charts' })),
      onUpdated: {
        addListener: (fn: (tabId: number, info: { status: string }) => void) => updateListeners.push(fn),
        removeListener: (fn: (tabId: number, info: { status: string }) => void) => {
          const i = updateListeners.indexOf(fn);
          if (i >= 0) updateListeners.splice(i, 1);
        },
      },
    },
    alarms: {
      create: vi.fn(async (name: string, info: chrome.alarms.AlarmCreateInfo) => {
        alarms.set(name, { name, info });
      }),
      clear: vi.fn(async (name: string) => {
        alarms.delete(name);
      }),
      get: vi.fn(async (name: string) => alarms.get(name)),
      onAlarm: {
        addListener: (fn: (alarm: { name: string }) => void) => alarmListeners.push(fn),
      },
    },
    notifications: { create: notifications },
  };
  vi.stubGlobal('chrome', fake);
  return { alarms, alarmListeners, createdTabs, removedTabs, notifications };
}

function secretSession(): RecordingSession {
  return {
    session_id: 's',
    tab_id: 1,
    started_at: TEST_T0,
    origin_url: 'https://app.test/login',
    origin_host: 'app.test',
    origin_title: 'Login',
    events: [
      { type: 'pageload', at: TEST_T0, url: 'https://app.test/login', title: 'Login', target: null },
      { type: 'input', at: TEST_T0 + 500, url: 'https://app.test/login', title: 'Login', target: passwordBox },
    ],
  };
}

/**
 * automations.ts's own waitForCompletion polls every RUN_POLL_MS (300ms) real time, so this
 * helper's per-tick delay must be long enough that a couple of its polls actually elapse —
 * a 0ms tick exhausts its budget before that first real interval passes.
 */
async function waitUntil<T>(fn: () => Promise<T | null>, predicate: (v: T | null) => boolean): Promise<T | null> {
  for (let i = 0; i < 100; i += 1) {
    const value = await fn();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('waitUntil timed out');
}

describe('canSchedule', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('rejects a flow with a high-risk step regardless of auto-approve', async () => {
    installChrome(vi.fn());
    const store = await import('../src/background/store');
    const automations = await import('../src/background/automations');

    const flow = compileFlow(secretSession(), OPTIONS); // has a secret => high risk step
    await store.saveFlow(flow);
    await (await import('../src/background/vault')).storeSecret(flow.flow_id, flow.variables[0]!.name, 'x');

    const check = await automations.canSchedule(flow, true);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('high-risk');
  });

  it('rejects a flow with checkpoints when auto-approve is false', async () => {
    installChrome(vi.fn());
    const store = await import('../src/background/store');
    const automations = await import('../src/background/automations');

    const flow = compileFlow(searchSession(), OPTIONS); // medium checkpoint at submit, no high risk
    await store.saveFlow(flow);

    const check = await automations.canSchedule(flow, false);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('checkpoints');
  });

  it('rejects a flow with a required secret that has no vault entry', async () => {
    installChrome(vi.fn());
    const store = await import('../src/background/store');
    const automations = await import('../src/background/automations');

    // Force a schedulable-shape flow (no high risk, no checkpoints) but with a declared
    // secret variable that has never been stored — construct it directly.
    const flow = compileFlow(searchSession(), OPTIONS);
    flow.checkpoints = [];
    flow.steps = flow.steps.map((s) => ({ ...s, risk: 'low' as const }));
    flow.variables.push({
      name: 'api_key',
      label: 'API Key',
      kind: 'secret',
      default: null,
      required: true,
      used_by: [],
    });
    await store.saveFlow(flow);

    const check = await automations.canSchedule(flow, true);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('api_key'.replace('api_key', 'API Key'));
  });

  it('accepts a flow with no high risk, no unapproved checkpoints, and all secrets stored', async () => {
    installChrome(vi.fn());
    const store = await import('../src/background/store');
    const vault = await import('../src/background/vault');
    const automations = await import('../src/background/automations');

    const flow = compileFlow(searchSession(), OPTIONS);
    await store.saveFlow(flow);

    const check = await automations.canSchedule(flow, true);
    expect(check.ok).toBe(true);
    void vault; // only needed if this flow had secret variables; it doesn't
  });
});

describe('createAutomation / schedule math', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  it('creates an interval alarm with the requested period', async () => {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { alarms } = installChrome(vi.fn());
    const store = await import('../src/background/store');
    const automations = await import('../src/background/automations');

    const flow = compileFlow(searchSession(), OPTIONS);
    await store.saveFlow(flow);

    const automation = await automations.createAutomation({
      flow_id: flow.flow_id,
      name: 'test',
      schedule: { kind: 'interval', every_minutes: 45 },
      auto_approve_checkpoints: true,
    });

    expect(alarms.get(automation.automation_id)?.info).toEqual({ periodInMinutes: 45 });
    vi.useRealTimers();
  });

  it('schedules a daily alarm for later today when the time has not passed yet', async () => {
    vi.setSystemTime(new Date('2026-01-01T08:00:00'));
    const { alarms } = installChrome(vi.fn());
    const store = await import('../src/background/store');
    const automations = await import('../src/background/automations');

    const flow = compileFlow(searchSession(), OPTIONS);
    await store.saveFlow(flow);

    const automation = await automations.createAutomation({
      flow_id: flow.flow_id,
      name: 'test',
      schedule: { kind: 'daily', hour: 9, minute: 30 },
      auto_approve_checkpoints: true,
    });

    const info = alarms.get(automation.automation_id)?.info;
    expect(info?.periodInMinutes).toBe(24 * 60);
    expect(new Date(info!.when!).toISOString()).toBe(new Date('2026-01-01T09:30:00').toISOString());
    vi.useRealTimers();
  });

  it('schedules a daily alarm for tomorrow when the time has already passed today', async () => {
    vi.setSystemTime(new Date('2026-01-01T10:00:00'));
    const { alarms } = installChrome(vi.fn());
    const store = await import('../src/background/store');
    const automations = await import('../src/background/automations');

    const flow = compileFlow(searchSession(), OPTIONS);
    await store.saveFlow(flow);

    const automation = await automations.createAutomation({
      flow_id: flow.flow_id,
      name: 'test',
      schedule: { kind: 'daily', hour: 9, minute: 0 },
      auto_approve_checkpoints: true,
    });

    const info = alarms.get(automation.automation_id)?.info;
    expect(new Date(info!.when!).toISOString()).toBe(new Date('2026-01-02T09:00:00').toISOString());
    vi.useRealTimers();
  });

  it('throws rather than creating an alarm when the flow cannot be scheduled', async () => {
    installChrome(vi.fn());
    const store = await import('../src/background/store');
    const automations = await import('../src/background/automations');

    const flow = compileFlow(searchSession(), OPTIONS);
    await store.saveFlow(flow);

    await expect(
      automations.createAutomation({
        flow_id: flow.flow_id,
        name: 'test',
        schedule: { kind: 'interval', every_minutes: 60 },
        auto_approve_checkpoints: false, // this flow has checkpoints
      }),
    ).rejects.toThrow(/checkpoints/);
    vi.useRealTimers();
  });
});

describe('onAlarm → runAutomation pipeline', () => {
  beforeEach(() => {
    vi.useRealTimers(); // defensive: a prior describe block's fake timers must not leak in
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('runs to completion, records an "ok" run, and closes the tab it opened', async () => {
    const { alarmListeners, createdTabs, removedTabs } = installChrome(vi.fn(async () => ({ ok: true })));
    const store = await import('../src/background/store');
    const automations = await import('../src/background/automations');

    const flow = compileFlow(searchSession(), OPTIONS);
    await store.saveFlow(flow);
    const automation = await automations.createAutomation({
      flow_id: flow.flow_id,
      name: 'test',
      schedule: { kind: 'interval', every_minutes: 60 },
      auto_approve_checkpoints: true,
    });

    alarmListeners[0]!({ name: automation.automation_id });

    const runs = await waitUntil(
      () => automations.listRuns(automation.automation_id),
      (runs) => (runs?.length ?? 0) > 0,
    );

    expect(runs![0]!.status).toBe('ok');
    expect(createdTabs).toHaveLength(1);
    expect(removedTabs).toEqual(createdTabs);
  });

  it('skips without opening a tab when a required secret has no vault entry', async () => {
    const { alarmListeners, createdTabs, notifications } = installChrome(vi.fn(async () => ({ ok: true })));
    const store = await import('../src/background/store');
    const vault = await import('../src/background/vault');
    const automations = await import('../src/background/automations');

    const flow = compileFlow(secretSession(), OPTIONS);
    flow.steps = flow.steps.map((s) => (s.risk === 'high' ? { ...s, risk: 'low' as const } : s));
    flow.checkpoints = [];
    await store.saveFlow(flow);
    const secretVar = flow.variables.find((v) => v.kind === 'secret')!;
    await vault.storeSecret(flow.flow_id, secretVar.name, 'temporary');
    const automation = await automations.createAutomation({
      flow_id: flow.flow_id,
      name: 'test',
      schedule: { kind: 'interval', every_minutes: 60 },
      auto_approve_checkpoints: true,
    });
    // Remove the secret *after* scheduling, simulating it being deleted later.
    await vault.deleteSecret(flow.flow_id, secretVar.name);

    alarmListeners[0]!({ name: automation.automation_id });

    const runs = await waitUntil(
      () => automations.listRuns(automation.automation_id),
      (runs) => (runs?.length ?? 0) > 0,
    );

    expect(runs![0]!.status).toBe('skipped');
    expect(createdTabs).toHaveLength(0);
    expect(notifications).toHaveBeenCalled();
  });

  it('records an "error" run and leaves the tab open when a step fails', async () => {
    const { alarmListeners, createdTabs, removedTabs, notifications } = installChrome(
      vi.fn(async () => ({ ok: false, error: 'selector not found' })),
    );
    const store = await import('../src/background/store');
    const automations = await import('../src/background/automations');

    const flow = compileFlow(searchSession(), OPTIONS);
    await store.saveFlow(flow);
    const automation = await automations.createAutomation({
      flow_id: flow.flow_id,
      name: 'test',
      schedule: { kind: 'interval', every_minutes: 60 },
      auto_approve_checkpoints: true,
    });

    alarmListeners[0]!({ name: automation.automation_id });

    const runs = await waitUntil(
      () => automations.listRuns(automation.automation_id),
      (runs) => (runs?.length ?? 0) > 0,
    );

    expect(runs![0]!.status).toBe('error');
    expect(createdTabs).toHaveLength(1);
    expect(removedTabs).toHaveLength(0);
    expect(notifications).toHaveBeenCalled();
  });

  it('disables the automation when its flow no longer exists', async () => {
    const { alarmListeners } = installChrome(vi.fn(async () => ({ ok: true })));
    const store = await import('../src/background/store');
    const automations = await import('../src/background/automations');

    const flow = compileFlow(searchSession(), OPTIONS);
    await store.saveFlow(flow);
    const automation = await automations.createAutomation({
      flow_id: flow.flow_id,
      name: 'test',
      schedule: { kind: 'interval', every_minutes: 60 },
      auto_approve_checkpoints: true,
    });
    await store.deleteFlow(flow.flow_id);

    alarmListeners[0]!({ name: automation.automation_id });

    await waitUntil(
      () => automations.listRuns(automation.automation_id),
      (runs) => (runs?.length ?? 0) > 0,
    );

    const reloaded = await automations.listAutomations();
    expect(reloaded.find((a) => a.automation_id === automation.automation_id)?.enabled).toBe(false);
  });
});
