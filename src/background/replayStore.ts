/**
 * Replay state lives in chrome.storage.session, not chrome.storage.local: it can hold a
 * secret's plaintext for the duration of a run, and session storage is memory-only and
 * cleared on browser close. Saved Flow JSON (store.ts) never shares a key namespace with
 * this, by construction.
 */
import type { ReplayState } from '../types/replay';

const KEY = 'eeveon_flow_replay_state';

export async function readReplayState(): Promise<ReplayState | null> {
  const bag = await chrome.storage.session.get(KEY);
  return (bag[KEY] as ReplayState | undefined) ?? null;
}

export async function writeReplayState(state: ReplayState | null): Promise<void> {
  if (state === null) {
    await chrome.storage.session.remove(KEY);
    return;
  }
  await chrome.storage.session.set({ [KEY]: state });
}
