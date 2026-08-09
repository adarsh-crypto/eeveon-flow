/**
 * Service worker — session orchestration.
 *
 * MV3 workers are killed between events, so nothing lives in module scope except code.
 * Every handler reads the session from storage, mutates, and writes it back.
 */
import type { Message, RecordingStatus, Response } from '../shared/messages';
import type { RecordingSession } from '../types/capture';
import { compileFlow } from '../compile/compileFlow';
import { validateFlow } from '../compile/validate';
import * as store from './store';
import * as replay from './replay';
import * as vault from './vault';
import * as automations from './automations';

const MAX_EVENTS = 20_000;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  void automations.reconcileAlarms();
});

// Alarms persist across a full browser restart, but this covers the (unlikely) case where
// an alarm was somehow dropped without the automation being disabled.
chrome.runtime.onStartup.addListener(() => {
  void automations.reconcileAlarms();
});

chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  // Every branch is async; returning true keeps the message channel open for sendResponse.
  void handle(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
  return true;
});

async function handle(message: Message, sender: chrome.runtime.MessageSender): Promise<Response> {
  switch (message.kind) {
    case 'is-recording': {
      const session = await store.readSession();
      const sameTab = session !== null && sender.tab?.id === session.tab_id;
      return { ok: true, recording: sameTab };
    }

    case 'events': {
      const session = await store.readSession();
      if (!session) return { ok: true };
      if (sender.tab?.id !== session.tab_id) return { ok: true };
      if (session.events.length >= MAX_EVENTS) return { ok: true };
      session.events.push(...message.events.slice(0, MAX_EVENTS - session.events.length));
      await store.writeSession(session);
      return { ok: true };
    }

    case 'start': {
      const existing = await store.readSession();
      if (existing) return { ok: false, error: 'already recording' };
      const tab = await chrome.tabs.get(message.tab_id);
      if (!tab.url || !/^https?:/.test(tab.url)) {
        return { ok: false, error: 'can only record http(s) pages' };
      }
      const session: RecordingSession = {
        session_id: crypto.randomUUID(),
        tab_id: message.tab_id,
        started_at: Date.now(),
        origin_url: tab.url,
        origin_host: new URL(tab.url).host,
        origin_title: tab.title ?? '',
        events: [],
      };
      await store.writeSession(session);
      await ensureContentScript(message.tab_id);
      await chrome.tabs.sendMessage(message.tab_id, { kind: 'start', tab_id: message.tab_id } satisfies Message);
      await paintBadge(true);
      return { ok: true, status: await statusOf(session) };
    }

    case 'stop': {
      const session = await store.readSession();
      if (!session) return { ok: false, error: 'not recording' };

      // Best-effort: the tab may already be closed, which is not a failure to stop.
      await chrome.tabs
        .sendMessage(session.tab_id, { kind: 'stop' } satisfies Message)
        .catch(() => undefined);

      // Let the final batch land before compiling.
      await new Promise((resolve) => setTimeout(resolve, 500));
      const settled = (await store.readSession()) ?? session;

      await store.writeSession(null);
      await paintBadge(false);

      if (settled.events.length === 0) {
        return { ok: false, error: 'nothing was recorded' };
      }

      const flow = compileFlow(settled);
      const result = validateFlow(flow);
      if (!result.valid) {
        // Save anyway: a flow with a broken step is still worth inspecting and repairing,
        // and discarding a recording the user just spent minutes making is worse.
        console.warn('[eeveon-flow] compiled flow has violations', result.violations);
      }
      await store.saveFlow(flow);
      return { ok: true, flow };
    }

    case 'status': {
      const session = await store.readSession();
      return { ok: true, status: await statusOf(session) };
    }

    case 'list-flows':
      return { ok: true, flows: await store.readIndex() };

    case 'get-flow': {
      const flow = await store.readFlow(message.flow_id);
      return flow ? { ok: true, flow } : { ok: false, error: 'flow not found' };
    }

    case 'delete-flow':
      await store.deleteFlow(message.flow_id);
      return { ok: true };

    case 'rename-flow':
      await store.renameFlow(message.flow_id, message.name);
      return { ok: true };

    case 'import-flow': {
      const result = validateFlow(message.flow);
      if (!result.valid) {
        const summary = result.violations.map((v) => `${v.rule}: ${v.message}`).join('; ');
        return { ok: false, error: `not a valid Flow document — ${summary}` };
      }
      // validateFlow (via FlowDocumentSchema.safeParse) is the only thing that establishes
      // message.flow really has this shape; the cast is only safe after that check passes.
      const flow = message.flow as import('../types/flow').FlowDocument;
      await store.saveFlow(flow);
      return { ok: true, flow };
    }

    case 'run-flow': {
      const state = await replay.startReplay(message);
      return { ok: true, replay: state };
    }

    case 'replay-status':
      return { ok: true, replay: await replay.getReplayStatus() };

    case 'approve-checkpoint':
      return { ok: true, replay: await replay.approveCheckpoint() };

    case 'reject-checkpoint':
      return { ok: true, replay: await replay.rejectCheckpoint() };

    case 'stop-replay':
      return { ok: true, replay: await replay.stopReplay() };

    case 'vault-list':
      return { ok: true, entries: await vault.listSecretMeta() };

    case 'vault-store-secret':
      await vault.storeSecret(message.flow_id, message.variable, message.value);
      return { ok: true };

    case 'vault-delete-secret':
      await vault.deleteSecret(message.flow_id, message.variable);
      return { ok: true };

    case 'automation-can-schedule': {
      const flow = await store.readFlow(message.flow_id);
      if (!flow) return { ok: false, error: 'flow not found' };
      const check = await automations.canSchedule(flow, message.auto_approve_checkpoints);
      return { ok: true, can_schedule: check.ok, reason: check.reason };
    }

    case 'automation-create': {
      try {
        const automation = await automations.createAutomation(message);
        return { ok: true, automation };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    case 'automation-set-enabled': {
      const automation = await automations.setAutomationEnabled(message.automation_id, message.enabled);
      return { ok: true, automation };
    }

    case 'automation-delete':
      await automations.deleteAutomation(message.automation_id);
      return { ok: true };

    case 'automation-list':
      return { ok: true, automations: await automations.listAutomations() };

    case 'automation-list-runs':
      return { ok: true, runs: await automations.listRuns(message.automation_id) };

    case 'run-step':
      // Sent by the background to a tab's content script via chrome.tabs.sendMessage;
      // it never arrives here (the worker's own onMessage only sees chrome.runtime
      // messages from the panel or a content script). Handled for exhaustiveness only.
      return { ok: false, error: 'run-step is not a worker-bound message' };

    default: {
      const never: never = message;
      return { ok: false, error: `unknown message ${JSON.stringify(never)}` };
    }
  }
}

async function statusOf(session: RecordingSession | null): Promise<RecordingStatus> {
  return {
    recording: session !== null,
    session_id: session?.session_id ?? null,
    tab_id: session?.tab_id ?? null,
    event_count: session?.events.length ?? 0,
    started_at: session?.started_at ?? null,
    origin_host: session?.origin_host ?? null,
  };
}

/**
 * The manifest declares the content script, but a tab loaded before install (or before the
 * extension was reloaded) has no script in it. Inject on demand; a duplicate injection is
 * harmless because the script guards its own listeners.
 */
async function ensureContentScript(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch {
    // Already injected, or the page forbids injection (chrome://, web store). The
    // subsequent sendMessage surfaces the real failure to the panel.
  }
}

/** A recording that is running must be visible without opening the panel. */
async function paintBadge(recording: boolean): Promise<void> {
  await chrome.action.setBadgeText({ text: recording ? 'REC' : '' });
  if (recording) {
    await chrome.action.setBadgeBackgroundColor({ color: '#c0392b' });
  }
}

// A recorded tab that closes ends the session; otherwise the next start is blocked forever
// by a session whose tab no longer exists.
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const session = await store.readSession();
    if (session && session.tab_id === tabId) {
      if (session.events.length > 0) {
        const flow = compileFlow(session);
        await store.saveFlow(flow);
      }
      await store.writeSession(null);
      await paintBadge(false);
    }
  })();
});

// Full page navigations in the recorded tab are steps; the content script cannot see the
// one that unloads it.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  void (async () => {
    const session = await store.readSession();
    if (!session || session.tab_id !== details.tabId) return;
    session.events.push({
      type: 'navigate',
      at: Date.now(),
      url: details.url,
      title: '',
      target: null,
    });
    await store.writeSession(session);
  })();
});
