/**
 * Flow validation — rules F1..F11 of spec/FLOW-SCHEMA-v0.1.md.
 *
 * Returns every violation rather than the first, because the caller shows them all in one
 * pass and a partially-repaired flow that fails again on export is worse than no export.
 */
import { FlowDocumentSchema, VERBS_REQUIRING_TARGET, type FlowDocument } from '../types/flow';

export interface Violation {
  rule: string;
  message: string;
  step_id?: string;
}

export interface ValidationResult {
  valid: boolean;
  violations: Violation[];
}

const MAX_BYTES = 2 * 1024 * 1024;
const COORDINATE_PATTERN = /(^|[^a-z])(x|y|left|top|clientx|clienty|pagex|pagey)\s*[:=]\s*-?\d/i;

export function validateFlow(input: unknown): ValidationResult {
  const parsed = FlowDocumentSchema.safeParse(input);
  if (!parsed.success) {
    return {
      valid: false,
      violations: parsed.error.issues.map((issue) => ({
        rule: 'F0_SCHEMA',
        message: `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      })),
    };
  }

  const flow: FlowDocument = parsed.data;
  const violations: Violation[] = [];

  // F6 runs against the *unparsed* input on purpose. Zod strips unknown keys, so a secret
  // value smuggling a `text` field would be silently sanitised by parsing and the leak
  // would never be reported — exactly the case this rule exists to catch.
  violations.push(...findSecretLiterals(input));

  // F1
  const major = flow.format_version.split('.')[0];
  if (!/^\d+\.\d+\.\d+$/.test(flow.format_version) || (major !== '0' && major !== '1')) {
    violations.push({
      rule: 'F1_FORMAT_VERSION',
      message: `unsupported format_version "${flow.format_version}"`,
    });
  }

  // F2
  if (flow.steps.length === 0) {
    violations.push({ rule: 'F2_STEPS_PRESENT', message: 'flow has no steps' });
  }

  // F3
  flow.steps.forEach((step, i) => {
    if (step.index !== i) {
      violations.push({
        rule: 'F3_INDEX_CONTIGUOUS',
        message: `step at position ${i} declares index ${step.index}`,
        step_id: step.step_id,
      });
    }
  });

  const variableNames = new Set(flow.variables.map((v) => v.name));
  const stepIds = new Set(flow.steps.map((s) => s.step_id));

  for (const step of flow.steps) {
    // F4
    if (VERBS_REQUIRING_TARGET.has(step.verb)) {
      if (!step.target || step.target.selectors.length === 0) {
        violations.push({
          rule: 'F4_TARGET_RESOLVABLE',
          message: `${step.verb} step has no usable selector`,
          step_id: step.step_id,
        });
      }
    }

    // F5
    for (const selector of step.target?.selectors ?? []) {
      if (COORDINATE_PATTERN.test(selector.value)) {
        violations.push({
          rule: 'F5_NO_COORDINATES',
          message: `selector "${selector.value}" looks coordinate-based`,
          step_id: step.step_id,
        });
      }
    }

    // F7
    if (
      (step.value?.kind === 'variable' || step.value?.kind === 'secret') &&
      !variableNames.has(step.value.variable)
    ) {
      violations.push({
        rule: 'F7_VARIABLES_DECLARED',
        message: `references undeclared variable "${step.value.variable}"`,
        step_id: step.step_id,
      });
    }

    // F8
    if (step.verb === 'navigate' && !isAbsoluteUrl(step.url)) {
      violations.push({
        rule: 'F8_URL_ON_NAVIGATE',
        message: 'navigate step has no absolute url',
        step_id: step.step_id,
      });
    }
  }

  // F9
  for (const checkpoint of flow.checkpoints) {
    if (!stepIds.has(checkpoint.before_step)) {
      violations.push({
        rule: 'F9_CHECKPOINT_TARGETS',
        message: `checkpoint ${checkpoint.checkpoint_id} points at unknown step ${checkpoint.before_step}`,
      });
    }
  }

  // F10
  const guarded = new Set(flow.checkpoints.map((c) => c.before_step));
  for (const step of flow.steps) {
    if (step.risk !== 'low' && !guarded.has(step.step_id)) {
      violations.push({
        rule: 'F10_RISK_COVERAGE',
        message: `${step.risk} risk step has no checkpoint`,
        step_id: step.step_id,
      });
    }
  }

  // F11
  const bytes = new TextEncoder().encode(JSON.stringify(flow)).length;
  if (bytes > MAX_BYTES) {
    violations.push({
      rule: 'F11_SIZE',
      message: `document is ${(bytes / 1024 / 1024).toFixed(2)} MB, limit is 2 MB`,
    });
  }

  return { valid: violations.length === 0, violations };
}

/** Walks the raw document looking for `{ kind: "secret", text: … }` anywhere in it. */
function findSecretLiterals(input: unknown): Violation[] {
  const violations: Violation[] = [];
  const document = input as { steps?: unknown };
  if (!Array.isArray(document?.steps)) return violations;

  for (const raw of document.steps) {
    const step = raw as { step_id?: unknown; value?: Record<string, unknown> | null };
    const value = step?.value;
    if (!value || typeof value !== 'object') continue;
    if (value.kind !== 'secret') continue;
    if (!('text' in value)) continue;
    violations.push({
      rule: 'F6_NO_SECRET_LITERALS',
      message: 'secret value carries plaintext',
      ...(typeof step.step_id === 'string' ? { step_id: step.step_id } : {}),
    });
  }
  return violations;
}

function isAbsoluteUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}
