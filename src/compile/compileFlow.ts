/**
 * Canonical events → Flow JSON.
 *
 * This is where a recording stops being a log and becomes an artifact: verbs get intents,
 * typed values become variables, risk becomes checkpoints.
 */
import type { RawEvent, RecordingSession } from '../types/capture';
import { toCanonical, type CanonicalEvent } from '../normalize/canonical';
import { collapse } from '../normalize/collapse';
import { assessRisk, hostOf } from './risk';
import {
  FLOW_FORMAT_VERSION,
  type Checkpoint,
  type FlowDocument,
  type FlowStep,
  type FlowVariable,
  type Target,
  type Value,
} from '../types/flow';

export interface CompileOptions {
  /** Defaults to a name derived from the origin title. */
  name?: string;
  description?: string;
  /** Skip the collapse stage and emit one step per canonical event. */
  atomic?: boolean;
  /** Injected so compilation is deterministic in tests. */
  now?: () => number;
  idFactory?: () => string;
}

export function compileFlow(session: RecordingSession, options: CompileOptions = {}): FlowDocument {
  const now = options.now ?? (() => Date.now());
  const newId = options.idFactory ?? defaultId;

  const canonical = toCanonical(session.events);
  const steps = options.atomic ? canonical : collapse(canonical);

  const variables = new Map<string, FlowVariable>();
  const flowSteps: FlowStep[] = [];

  steps.forEach((event, index) => {
    const stepId = `s_${index + 1}`;
    const risk = assessRisk(event, session.origin_host);
    const value = buildValue(event, stepId, variables);
    const target = buildTarget(event);

    flowSteps.push({
      step_id: stepId,
      index,
      verb: event.verb,
      intent: describeIntent(event, value),
      target,
      value,
      url: event.verb === 'navigate' || event.url !== session.origin_url ? event.url : null,
      risk: risk.level,
      timing: {
        offset_ms: Math.max(0, event.at - session.started_at),
        dwell_ms: 0,
      },
      collapsed_from: event.raw_count,
      notes: risk.reason ? [risk.reason] : [],
    });
  });

  fillDwell(flowSteps);

  const checkpoints = buildCheckpoints(flowSteps);

  return {
    format_version: FLOW_FORMAT_VERSION,
    flow_id: newId(),
    name: options.name?.trim() || defaultName(session),
    description: options.description ?? null,
    created_at: new Date(now()).toISOString(),
    origin: {
      url: session.origin_url,
      host: session.origin_host,
      title: session.origin_title,
    },
    variables: [...variables.values()],
    steps: flowSteps,
    checkpoints,
    provenance: {
      recorder: 'eeveon-flow',
      recorder_version: FLOW_FORMAT_VERSION,
      raw_event_count: session.events.length,
      step_count: flowSteps.length,
      collapsed: !options.atomic,
    },
  };
}

/** Convenience for callers holding loose events rather than a session. */
export function compileEvents(
  events: RawEvent[],
  origin: { url: string; host: string; title: string },
  options: CompileOptions = {},
): FlowDocument {
  const startedAt = events[0]?.at ?? 0;
  return compileFlow(
    {
      session_id: 'adhoc',
      tab_id: -1,
      started_at: startedAt,
      origin_url: origin.url,
      origin_host: origin.host,
      origin_title: origin.title,
      events,
    },
    options,
  );
}

function buildTarget(event: CanonicalEvent): Target | null {
  if (!event.target) return null;
  return {
    tag: event.target.tag,
    role: event.target.role,
    name: event.target.name,
    selectors: event.target.selectors,
    frame: null,
  };
}

/**
 * Every typed value becomes a variable so a recording of "search for half-life" replays as
 * "search for anything". Secrets become required variables with no default — the plaintext
 * was never captured, so there is nothing to default to.
 */
function buildValue(
  event: CanonicalEvent,
  stepId: string,
  variables: Map<string, FlowVariable>,
): Value | null {
  if (event.verb !== 'type' && event.verb !== 'select' && event.verb !== 'key_press') return null;

  if (event.verb === 'key_press') {
    return event.key ? { kind: 'literal', text: event.key } : null;
  }

  const label = event.target?.name ?? event.target?.tag ?? 'value';

  if (event.secret) {
    const name = uniqueVariableName(variables, label);
    upsertVariable(variables, {
      name,
      label,
      kind: 'secret',
      default: null,
      required: true,
      used_by: [stepId],
    });
    return { kind: 'secret', variable: name };
  }

  if (event.text === null || event.text === '') return null;

  const name = uniqueVariableName(variables, label);
  upsertVariable(variables, {
    name,
    label,
    kind: 'text',
    default: event.text,
    required: false,
    used_by: [stepId],
  });
  return { kind: 'variable', variable: name };
}

function upsertVariable(variables: Map<string, FlowVariable>, variable: FlowVariable): void {
  const existing = variables.get(variable.name);
  if (existing) {
    existing.used_by.push(...variable.used_by);
    return;
  }
  variables.set(variable.name, variable);
}

function uniqueVariableName(variables: Map<string, FlowVariable>, label: string): string {
  const base = slug(label) || 'value';
  if (!variables.has(base)) return base;
  // Same label used twice in one flow (two "Name" fields) gets a numeric suffix.
  let n = 2;
  while (variables.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^([0-9])/, 'v$1')
    .slice(0, 40);
}

function describeIntent(event: CanonicalEvent, value: Value | null): string {
  const name = event.target?.name;
  const what = name ? `"${name}"` : event.target ? `the ${event.target.tag}` : '';

  switch (event.verb) {
    case 'navigate':
      return `Go to ${event.url}`;
    case 'click':
      return `Click ${what || 'the element'}`;
    case 'type': {
      if (value?.kind === 'secret') return `Enter the ${value.variable} into ${what || 'the field'}`;
      const shown = value?.kind === 'variable' ? `{{${value.variable}}}` : 'text';
      return `Type ${shown} into ${what || 'the field'}`;
    }
    case 'select':
      return `Set ${what || 'the control'}`;
    case 'submit':
      return `Submit ${what || 'the form'}`;
    case 'key_press':
      return `Press ${event.key ?? 'a key'}`;
    case 'scroll':
      return 'Scroll the page';
    case 'hover':
      return `Hover ${what || 'the element'}`;
    case 'wait':
      return 'Wait for the page to settle';
    case 'assert':
      return `Check ${what || 'the page'}`;
    default:
      return 'Perform the recorded action';
  }
}

/** Dwell is the gap until the next step — how long the user looked before acting again. */
function fillDwell(steps: FlowStep[]): void {
  for (let i = 0; i < steps.length - 1; i += 1) {
    const current = steps[i]!;
    const next = steps[i + 1]!;
    current.timing.dwell_ms = Math.max(0, next.timing.offset_ms - current.timing.offset_ms);
  }
}

function buildCheckpoints(steps: FlowStep[]): Checkpoint[] {
  const checkpoints: Checkpoint[] = [];
  for (const step of steps) {
    if (step.risk === 'low') continue;
    checkpoints.push({
      checkpoint_id: `cp_${checkpoints.length + 1}`,
      before_step: step.step_id,
      reason: step.notes[0] ?? `${step.risk} risk step`,
      severity: step.risk === 'high' ? 'high' : 'medium',
    });
  }
  return checkpoints;
}

function defaultName(session: RecordingSession): string {
  const title = session.origin_title.trim();
  if (title) return `${title} workflow`.slice(0, 120);
  return `${session.origin_host} workflow`;
}

function defaultId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `flow_${Math.random().toString(36).slice(2, 12)}`;
}
