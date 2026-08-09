/**
 * Risk is derived from signals at compile time, never authored by hand. The rules are the
 * ones in spec/FLOW-SCHEMA-v0.1.md §"Risk model" — keep the two in step.
 */
import type { CanonicalEvent } from '../normalize/canonical';
import type { RiskLevel } from '../types/flow';

/** Accessible names that indicate the click does something a user cannot undo. */
const DESTRUCTIVE = /\b(delete|remove|destroy|drop|revoke|terminate|cancel subscription|deactivate|pay|buy|purchase|checkout|order|transfer|send money|confirm|deploy|publish|merge|force)\b/i;

export interface RiskAssessment {
  level: RiskLevel;
  reason: string | null;
}

export function assessRisk(event: CanonicalEvent, originHost: string): RiskAssessment {
  if (event.secret) {
    return { level: 'high', reason: 'enters a credential' };
  }

  const name = event.target?.name ?? '';
  if ((event.verb === 'click' || event.verb === 'submit') && DESTRUCTIVE.test(name)) {
    const match = DESTRUCTIVE.exec(name);
    const verb = (match?.[0] ?? 'a destructive').toLowerCase();
    return { level: 'high', reason: `performs "${verb}" action` };
  }

  if (event.verb === 'submit') {
    return { level: 'medium', reason: 'submits a form' };
  }

  if (event.verb === 'navigate') {
    const host = hostOf(event.url);
    if (host && host !== originHost) {
      return { level: 'medium', reason: `leaves ${originHost} for ${host}` };
    }
  }

  return { level: 'low', reason: null };
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
