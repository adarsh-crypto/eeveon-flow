/**
 * The message the background sends to the content script for one step. Deliberately not
 * a FlowStep: `value` has already been resolved from a variable reference to the literal
 * text the page should receive, so the content script never needs the variable map (and a
 * secret's plaintext exists only for the moment it crosses this one message, in memory).
 */
import type { FlowVerb } from '../types/primitives';
import type { Target } from '../types/flow';

export interface ReplayActionPayload {
  step_id: string;
  verb: FlowVerb;
  target: Target | null;
  /** Resolved literal for type/select/key_press. Null for verbs that don't carry a value. */
  text: string | null;
  url: string | null;
}

export interface StepResult {
  ok: boolean;
  error?: string;
  /** Selector attempts, present when target resolution failed or on request. */
  tried?: string[];
}
