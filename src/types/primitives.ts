/**
 * Vocabulary shared by every stage, with no runtime dependencies.
 *
 * This is split out of flow.ts on purpose: flow.ts pulls in zod, and the content script
 * needs the selector constants but must stay small — it is injected into every page the
 * user visits, so a validation library has no business riding along.
 */

export const FLOW_FORMAT_VERSION = '0.1.0';

export const SELECTOR_STRATEGIES = ['testid', 'role', 'label', 'text', 'name', 'id', 'css'] as const;
export type SelectorStrategy = (typeof SELECTOR_STRATEGIES)[number];

/** Best-first priority. Higher score wins when a target exposes several strategies. */
export const SELECTOR_SCORE: Record<SelectorStrategy, number> = {
  testid: 100,
  role: 90,
  label: 80,
  text: 70,
  name: 50,
  id: 45,
  css: 30,
};

export const FLOW_VERBS = [
  'navigate',
  'click',
  'type',
  'select',
  'submit',
  'key_press',
  'scroll',
  'hover',
  'wait',
  'assert',
] as const;
export type FlowVerb = (typeof FLOW_VERBS)[number];

/** Verbs that cannot execute without an element to act on. Drives rule F4. */
export const VERBS_REQUIRING_TARGET: ReadonlySet<FlowVerb> = new Set<FlowVerb>([
  'click',
  'type',
  'select',
  'submit',
  'hover',
  'assert',
]);

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
