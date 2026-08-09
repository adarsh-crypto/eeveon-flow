import { describe, expect, it } from 'vitest';
import { compileFlow } from '../src/compile/compileFlow';
import { validateFlow } from '../src/compile/validate';
import { searchSession, passwordBox, deleteButton, TEST_T0 } from './fixtures/search-recording';
import type { RecordingSession } from '../src/types/capture';

const OPTIONS = { now: () => TEST_T0, idFactory: () => 'flow-fixed-id' };

describe('compileFlow', () => {
  const flow = compileFlow(searchSession(), OPTIONS);

  it('produces a valid document', () => {
    const result = validateFlow(flow);
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('is deterministic', () => {
    expect(compileFlow(searchSession(), OPTIONS)).toEqual(flow);
  });

  it('records provenance including the raw event count', () => {
    expect(flow.provenance.raw_event_count).toBe(searchSession().events.length);
    expect(flow.provenance.step_count).toBe(flow.steps.length);
    expect(flow.provenance.collapsed).toBe(true);
  });

  it('turns the typed query into a variable with the recorded value as its default', () => {
    const variable = flow.variables.find((v) => v.kind === 'text');
    expect(variable?.default).toBe('half-life');
    expect(variable?.required).toBe(false);
    const step = flow.steps.find((s) => s.verb === 'type');
    expect(step?.value).toEqual({ kind: 'variable', variable: variable?.name });
  });

  it('numbers steps contiguously from zero', () => {
    expect(flow.steps.map((s) => s.index)).toEqual(flow.steps.map((_, i) => i));
  });

  it('emits a checkpoint for the form submission', () => {
    const submit = flow.steps.find((s) => s.verb === 'submit');
    expect(submit?.risk).toBe('medium');
    expect(flow.checkpoints.some((c) => c.before_step === submit?.step_id)).toBe(true);
  });

  it('keeps atomic mode one step per canonical event', () => {
    const atomic = compileFlow(searchSession(), { ...OPTIONS, atomic: true });
    expect(atomic.steps.length).toBeGreaterThan(flow.steps.length);
    expect(atomic.provenance.collapsed).toBe(false);
    expect(validateFlow(atomic).valid).toBe(true);
  });
});

describe('secret handling', () => {
  function sessionWith(target: typeof passwordBox): RecordingSession {
    return {
      session_id: 's',
      tab_id: 1,
      started_at: TEST_T0,
      origin_url: 'https://app.test/login',
      origin_host: 'app.test',
      origin_title: 'Login',
      events: [
        { type: 'pageload', at: TEST_T0, url: 'https://app.test/login', title: 'Login', target: null },
        // No `text` — the content script never read the value.
        { type: 'input', at: TEST_T0 + 500, url: 'https://app.test/login', title: 'Login', target },
      ],
    };
  }

  const flow = compileFlow(sessionWith(passwordBox), OPTIONS);

  it('marks the value secret and never carries plaintext', () => {
    const step = flow.steps.find((s) => s.verb === 'type');
    expect(step?.value?.kind).toBe('secret');
    expect(JSON.stringify(flow)).not.toContain('"text"');
  });

  it('declares the secret as a required variable with no default', () => {
    const variable = flow.variables.find((v) => v.kind === 'secret');
    expect(variable).toMatchObject({ required: true, default: null });
  });

  it('rates the step high risk and guards it with a checkpoint', () => {
    const step = flow.steps.find((s) => s.verb === 'type');
    expect(step?.risk).toBe('high');
    expect(flow.checkpoints.find((c) => c.before_step === step?.step_id)?.severity).toBe('high');
  });
});

describe('risk', () => {
  it('rates a destructive click high', () => {
    const flow = compileFlow(
      {
        session_id: 's',
        tab_id: 1,
        started_at: TEST_T0,
        origin_url: 'https://app.test/settings',
        origin_host: 'app.test',
        origin_title: 'Settings',
        events: [
          { type: 'pageload', at: TEST_T0, url: 'https://app.test/settings', title: 'S', target: null },
          {
            type: 'click',
            at: TEST_T0 + 1_000,
            url: 'https://app.test/settings',
            title: 'S',
            target: deleteButton,
          },
        ],
      },
      OPTIONS,
    );
    const click = flow.steps.find((s) => s.verb === 'click');
    expect(click?.risk).toBe('high');
    expect(click?.notes[0]).toContain('delete');
  });

  it('rates a cross-host navigation medium', () => {
    const flow = compileFlow(
      {
        session_id: 's',
        tab_id: 1,
        started_at: TEST_T0,
        origin_url: 'https://app.test/',
        origin_host: 'app.test',
        origin_title: 'App',
        events: [
          { type: 'pageload', at: TEST_T0, url: 'https://app.test/', title: 'App', target: null },
          {
            type: 'navigate',
            at: TEST_T0 + 20_000,
            url: 'https://payments.example/checkout',
            title: 'Pay',
            target: null,
          },
        ],
      },
      OPTIONS,
    );
    const external = flow.steps[1];
    expect(external?.risk).toBe('medium');
    expect(external?.notes[0]).toContain('payments.example');
  });
});
