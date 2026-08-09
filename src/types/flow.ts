/**
 * Flow JSON — the portable artifact. See spec/FLOW-SCHEMA-v0.1.md.
 *
 * Everything downstream (validator, exporters, future runners) depends only on this
 * module. The recorder's raw event shapes live in src/types/capture.ts and never leak
 * past the normaliser.
 */
import { z } from 'zod';
import { FLOW_VERBS, RISK_LEVELS, SELECTOR_STRATEGIES } from './primitives';

// The zod-free vocabulary lives in primitives.ts so the content script can import it
// without pulling zod into every page. Re-exported here so consumers have one import.
export {
  FLOW_FORMAT_VERSION,
  FLOW_VERBS,
  RISK_LEVELS,
  SELECTOR_SCORE,
  SELECTOR_STRATEGIES,
  VERBS_REQUIRING_TARGET,
} from './primitives';
export type { FlowVerb, RiskLevel, SelectorStrategy } from './primitives';

export const SelectorSchema = z.object({
  strategy: z.enum(SELECTOR_STRATEGIES),
  value: z.string().min(1),
  score: z.number().int().min(0).max(100),
});
export type Selector = z.infer<typeof SelectorSchema>;

export const TargetSchema = z.object({
  tag: z.string().min(1),
  role: z.string().nullable(),
  name: z.string().nullable(),
  selectors: z.array(SelectorSchema),
  frame: z.string().nullable(),
});
export type Target = z.infer<typeof TargetSchema>;

export const ValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('literal'), text: z.string() }),
  z.object({ kind: z.literal('variable'), variable: z.string().min(1) }),
  // No `text` member by construction — a secret's plaintext must never reach the document.
  z.object({ kind: z.literal('secret'), variable: z.string().min(1) }),
]);
export type Value = z.infer<typeof ValueSchema>;

export const FlowVariableSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1),
  kind: z.enum(['text', 'secret']),
  default: z.string().nullable(),
  required: z.boolean(),
  used_by: z.array(z.string()),
});
export type FlowVariable = z.infer<typeof FlowVariableSchema>;

export const FlowStepSchema = z.object({
  step_id: z.string().min(1),
  index: z.number().int().min(0),
  verb: z.enum(FLOW_VERBS),
  intent: z.string().min(1),
  target: TargetSchema.nullable(),
  value: ValueSchema.nullable(),
  url: z.string().nullable(),
  risk: z.enum(RISK_LEVELS),
  timing: z.object({
    offset_ms: z.number().int().min(0),
    dwell_ms: z.number().int().min(0),
  }),
  collapsed_from: z.number().int().min(1),
  notes: z.array(z.string()),
});
export type FlowStep = z.infer<typeof FlowStepSchema>;

export const CheckpointSchema = z.object({
  checkpoint_id: z.string().min(1),
  before_step: z.string().min(1),
  reason: z.string().min(1),
  severity: z.enum(['medium', 'high']),
});
export type Checkpoint = z.infer<typeof CheckpointSchema>;

export const FlowDocumentSchema = z.object({
  format_version: z.string(),
  flow_id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  created_at: z.string(),
  origin: z.object({
    url: z.string(),
    host: z.string(),
    title: z.string(),
  }),
  variables: z.array(FlowVariableSchema),
  steps: z.array(FlowStepSchema),
  checkpoints: z.array(CheckpointSchema),
  provenance: z.object({
    recorder: z.string(),
    recorder_version: z.string(),
    raw_event_count: z.number().int().min(0),
    step_count: z.number().int().min(0),
    collapsed: z.boolean(),
  }),
});
export type FlowDocument = z.infer<typeof FlowDocumentSchema>;

/** Convenience for exporters: resolve a step's value to display text. */
export function describeValue(value: Value | null): string {
  if (!value) return '';
  if (value.kind === 'literal') return JSON.stringify(value.text);
  if (value.kind === 'variable') return `{{${value.variable}}}`;
  return `{{${value.variable}}} (secret, supplied at run time)`;
}
