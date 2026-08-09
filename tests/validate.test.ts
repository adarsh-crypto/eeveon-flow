import { describe, expect, it } from 'vitest';
import { compileFlow } from '../src/compile/compileFlow';
import { validateFlow } from '../src/compile/validate';
import { searchSession, TEST_T0 } from './fixtures/search-recording';
import type { FlowDocument } from '../src/types/flow';

const OPTIONS = { now: () => TEST_T0, idFactory: () => 'flow-fixed-id' };

function freshFlow(): FlowDocument {
  return structuredClone(compileFlow(searchSession(), OPTIONS));
}

function rules(flow: unknown): string[] {
  return validateFlow(flow).violations.map((v) => v.rule);
}

describe('validateFlow', () => {
  it('accepts a compiled flow', () => {
    expect(validateFlow(freshFlow()).valid).toBe(true);
  });

  it('rejects a non-flow object with a schema violation', () => {
    expect(rules({ hello: 'world' })).toContain('F0_SCHEMA');
  });

  it('F1 — rejects an unsupported major version', () => {
    const flow = freshFlow();
    flow.format_version = '9.0.0';
    expect(rules(flow)).toContain('F1_FORMAT_VERSION');
  });

  it('F2 — rejects an empty flow', () => {
    const flow = freshFlow();
    flow.steps = [];
    flow.checkpoints = [];
    expect(rules(flow)).toContain('F2_STEPS_PRESENT');
  });

  it('F3 — catches a gap in step indices', () => {
    const flow = freshFlow();
    flow.steps[1]!.index = 7;
    expect(rules(flow)).toContain('F3_INDEX_CONTIGUOUS');
  });

  it('F4 — catches a click with no selector', () => {
    const flow = freshFlow();
    const click = flow.steps.find((s) => s.verb === 'click')!;
    click.target!.selectors = [];
    expect(rules(flow)).toContain('F4_TARGET_RESOLVABLE');
  });

  it('F5 — catches a coordinate-shaped selector', () => {
    const flow = freshFlow();
    const click = flow.steps.find((s) => s.verb === 'click')!;
    click.target!.selectors = [{ strategy: 'css', value: 'div[x=120]', score: 30 }];
    expect(rules(flow)).toContain('F5_NO_COORDINATES');
  });

  it('F6 — catches plaintext smuggled onto a secret value', () => {
    const flow = freshFlow();
    const step = flow.steps.find((s) => s.verb === 'type')!;
    step.value = { kind: 'secret', variable: 'password', text: 'hunter2' } as never;
    flow.variables.push({
      name: 'password',
      label: 'Password',
      kind: 'secret',
      default: null,
      required: true,
      used_by: [step.step_id],
    });
    expect(rules(flow)).toContain('F6_NO_SECRET_LITERALS');
  });

  it('F7 — catches a reference to an undeclared variable', () => {
    const flow = freshFlow();
    flow.variables = [];
    expect(rules(flow)).toContain('F7_VARIABLES_DECLARED');
  });

  it('F8 — catches a navigate step with no url', () => {
    const flow = freshFlow();
    flow.steps.find((s) => s.verb === 'navigate')!.url = null;
    expect(rules(flow)).toContain('F8_URL_ON_NAVIGATE');
  });

  it('F9 — catches a checkpoint pointing at a missing step', () => {
    const flow = freshFlow();
    flow.checkpoints.push({
      checkpoint_id: 'cp_x',
      before_step: 's_999',
      reason: 'nowhere',
      severity: 'medium',
    });
    expect(rules(flow)).toContain('F9_CHECKPOINT_TARGETS');
  });

  it('F10 — catches a risky step with no checkpoint', () => {
    const flow = freshFlow();
    flow.checkpoints = [];
    expect(rules(flow)).toContain('F10_RISK_COVERAGE');
  });

  it('reports every violation, not just the first', () => {
    const flow = freshFlow();
    flow.format_version = '9.0.0';
    flow.checkpoints = [];
    const found = rules(flow);
    expect(found).toContain('F1_FORMAT_VERSION');
    expect(found).toContain('F10_RISK_COVERAGE');
  });
});
