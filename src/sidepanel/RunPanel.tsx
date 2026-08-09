import { useEffect, useMemo, useState } from 'react';
import type { Message, Response } from '../shared/messages';
import type { FlowDocument } from '../types/flow';
import type { ReplayState } from '../types/replay';

async function send(message: Message): Promise<Response> {
  return (await chrome.runtime.sendMessage(message)) as Response;
}

function replayOf(response: Response): ReplayState | null {
  return response.ok && 'replay' in response ? response.replay : null;
}

interface Props {
  flow: FlowDocument;
  /**
   * Which tab to run against. Omit to run against the active tab of the current window —
   * correct for the side panel (which isn't itself a tab). A host page that IS a tab (the
   * dashboard) must pass this explicitly, or "active tab" would resolve to the dashboard
   * itself.
   */
  tabId?: number;
}

export default function RunPanel({ flow, tabId }: Props) {
  const [values, setValues] = useState<Record<string, string>>(() => defaultValues(flow));
  const [state, setState] = useState<ReplayState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A different flow selected mid-run should not show stale inputs for the old one.
  useEffect(() => {
    setValues(defaultValues(flow));
    setState(null);
    setError(null);
  }, [flow.flow_id]);

  const active = state !== null && (state.status === 'running' || state.status === 'paused-approval');

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      void send({ kind: 'replay-status' }).then((response) => {
        const next = replayOf(response);
        if (next && next.flow_id === flow.flow_id) setState(next);
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, [active, flow.flow_id]);

  const missingSecret = useMemo(
    () => flow.variables.some((v) => v.kind === 'secret' && !values[v.name]),
    [flow.variables, values],
  );

  const run = async () => {
    setError(null);
    let targetTabId = tabId;
    if (targetTabId === undefined) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      targetTabId = tab?.id;
    }
    if (targetTabId === undefined) {
      setError('no target tab — pick one, or open the page you want to run against');
      return;
    }
    const response = await send({ kind: 'run-flow', flow_id: flow.flow_id, tab_id: targetTabId, variables: values });
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setState(replayOf(response));
  };

  const approve = async () => {
    const response = await send({ kind: 'approve-checkpoint' });
    if (!response.ok) setError(response.error);
    else setState(replayOf(response));
  };

  const reject = async () => {
    const response = await send({ kind: 'reject-checkpoint' });
    if (!response.ok) setError(response.error);
    else setState(replayOf(response));
  };

  const stop = async () => {
    const response = await send({ kind: 'stop-replay' });
    if (!response.ok) setError(response.error);
    else setState(replayOf(response));
  };

  const logByStep = new Map((state?.log ?? []).map((entry) => [entry.step_id, entry]));
  const currentStepId = state ? flow.steps[state.step_index]?.step_id : undefined;

  return (
    <section className="run">
      <h2>Run</h2>

      {!active && flow.variables.length > 0 && (
        <div className="run-inputs">
          {flow.variables.map((variable) => (
            <label key={variable.name} className="run-input">
              <span>
                {variable.label}
                {variable.kind === 'secret' ? ' (secret, not saved anywhere)' : ''}
              </span>
              <input
                type={variable.kind === 'secret' ? 'password' : 'text'}
                value={values[variable.name] ?? ''}
                placeholder={variable.kind === 'secret' ? 'required' : ''}
                onChange={(event) => setValues((prev) => ({ ...prev, [variable.name]: event.target.value }))}
              />
            </label>
          ))}
        </div>
      )}

      {!active && (
        <button className="button button-primary" disabled={missingSecret} onClick={() => void run()}>
          {missingSecret ? 'Fill in required secrets to run' : 'Run this flow'}
        </button>
      )}

      {error && <p className="error">{error}</p>}

      {state && (
        <>
          <p className="meta">
            {state.status === 'running' && `Running step ${state.step_index + 1} of ${flow.steps.length}`}
            {state.status === 'paused-approval' && 'Waiting for your approval'}
            {state.status === 'done' && 'Finished'}
            {state.status === 'error' && `Stopped: ${state.error ?? 'error'}`}
            {state.status === 'stopped' && 'Stopped'}
          </p>

          {state.status === 'paused-approval' && state.pending_checkpoint && (
            <div className="checkpoint">
              <p>
                <strong>{state.pending_checkpoint.severity} risk</strong> — this step{' '}
                {state.pending_checkpoint.reason}. Continue?
              </p>
              <div className="checkpoint-actions">
                <button className="button button-primary" onClick={() => void approve()}>
                  Approve
                </button>
                <button className="button button-danger" onClick={() => void reject()}>
                  Stop instead
                </button>
              </div>
            </div>
          )}

          {active && state.status === 'running' && (
            <button className="button button-danger" onClick={() => void stop()}>
              Stop run
            </button>
          )}

          <ol className="steps run-steps">
            {flow.steps.map((step) => {
              const entry = logByStep.get(step.step_id);
              const isCurrent = step.step_id === currentStepId && active;
              const cls = entry ? `run-${entry.status}` : isCurrent ? 'run-current' : '';
              return (
                <li key={step.step_id} className={`risk-${step.risk} ${cls}`}>
                  <span className="verb">{step.verb}</span>
                  <span className="intent">{step.intent}</span>
                  {entry?.status === 'error' && <span className="run-error-msg">{entry.message}</span>}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

function defaultValues(flow: FlowDocument): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of flow.variables) {
    if (variable.kind === 'text') values[variable.name] = variable.default ?? '';
  }
  return values;
}
