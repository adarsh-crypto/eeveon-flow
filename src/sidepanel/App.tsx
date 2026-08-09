import { useCallback, useEffect, useState } from 'react';
import type { Message, RecordingStatus, Response, SavedFlowSummary } from '../shared/messages';
import type { FlowDocument } from '../types/flow';
import { validateFlow, type Violation } from '../compile/validate';
import { exportFlow, type ExportFormat } from '../export';
import { downloadArtifact } from '../shared/download';
import RunPanel from './RunPanel';

async function send(message: Message): Promise<Response> {
  return (await chrome.runtime.sendMessage(message)) as Response;
}

const EMPTY_STATUS: RecordingStatus = {
  recording: false,
  session_id: null,
  tab_id: null,
  event_count: 0,
  started_at: null,
  origin_host: null,
};

export default function App() {
  const [status, setStatus] = useState<RecordingStatus>(EMPTY_STATUS);
  const [flows, setFlows] = useState<SavedFlowSummary[]>([]);
  const [selected, setSelected] = useState<FlowDocument | null>(null);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [statusResponse, listResponse] = await Promise.all([
      send({ kind: 'status' }),
      send({ kind: 'list-flows' }),
    ]);
    if (statusResponse.ok && 'status' in statusResponse) setStatus(statusResponse.status);
    if (listResponse.ok && 'flows' in listResponse) setFlows(listResponse.flows);
  }, []);

  useEffect(() => {
    void refresh();
    // Poll while recording so the event counter moves; the worker cannot push to a panel
    // that may be closed.
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const start = async () => {
    setError(null);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setError('no active tab');
      return;
    }
    const response = await send({ kind: 'start', tab_id: tab.id });
    if (!response.ok) setError(response.error);
    await refresh();
  };

  const stop = async () => {
    setError(null);
    const response = await send({ kind: 'stop' });
    if (!response.ok) {
      setError(response.error);
    } else if ('flow' in response) {
      openFlow(response.flow);
    }
    await refresh();
  };

  const openFlow = (flow: FlowDocument) => {
    setSelected(flow);
    setViolations(validateFlow(flow).violations);
  };

  const load = async (flowId: string) => {
    const response = await send({ kind: 'get-flow', flow_id: flowId });
    if (response.ok && 'flow' in response) openFlow(response.flow);
  };

  const remove = async (flowId: string) => {
    await send({ kind: 'delete-flow', flow_id: flowId });
    if (selected?.flow_id === flowId) setSelected(null);
    await refresh();
  };

  const download = (format: ExportFormat) => {
    if (!selected) return;
    downloadArtifact(exportFlow(selected, format));
  };

  const elapsed = status.started_at ? Math.round((Date.now() - status.started_at) / 1000) : 0;

  const openDashboard = () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
  };

  return (
    <div className="panel">
      <header className="brand-row">
        <div className="brand">
          <span className="brand-mark">EE</span>
          <div>
            <h1>EEVEON Flow</h1>
            <p className="tagline">Record a workflow. Ship it as a skill.</p>
          </div>
        </div>
        <button className="button dashboard-link" onClick={openDashboard}>
          Dashboard
        </button>
      </header>

      <section className="recorder">
        {status.recording ? (
          <>
            <div className="rec-line">
              <span className="dot" /> Recording {status.origin_host} · {status.event_count} events · {elapsed}s
            </div>
            <button className="button button-primary stop" onClick={() => void stop()}>
              Stop and compile
            </button>
          </>
        ) : (
          <button className="button button-primary" onClick={() => void start()}>
            Record this tab
          </button>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      {selected && (
        <section className="flow">
          <h2>{selected.name}</h2>
          <p className="meta">
            {selected.steps.length} steps · {selected.variables.length} inputs ·{' '}
            {selected.checkpoints.length} approvals · from {selected.provenance.raw_event_count} raw events
          </p>

          {violations.length > 0 && (
            <ul className="violations">
              {violations.map((violation, i) => (
                <li key={i}>
                  <code>{violation.rule}</code> {violation.message}
                  {violation.step_id ? ` (${violation.step_id})` : ''}
                </li>
              ))}
            </ul>
          )}

          <ol className="steps">
            {selected.steps.map((step) => (
              <li key={step.step_id} className={`risk-${step.risk}`}>
                <span className="verb">{step.verb}</span>
                <span className="intent">{step.intent}</span>
                {step.collapsed_from > 1 && <span className="fold">×{step.collapsed_from}</span>}
              </li>
            ))}
          </ol>

          <div className="exports">
            <button className="button" onClick={() => download('json')}>
              Flow JSON
            </button>
            <button className="button" onClick={() => download('skill')}>
              SKILL.md
            </button>
            <button className="button" onClick={() => download('playwright')}>
              Playwright
            </button>
          </div>
        </section>
      )}

      {selected && <RunPanel flow={selected} key={selected.flow_id} />}

      <section className="library">
        <h2>Saved flows</h2>
        {flows.length === 0 && <p className="empty">Nothing recorded yet.</p>}
        <ul>
          {flows.map((flow) => (
            <li key={flow.flow_id}>
              <button className="link" onClick={() => void load(flow.flow_id)}>
                {flow.name}
              </button>
              <span className="meta">
                {flow.step_count} steps · {flow.host}
              </span>
              <button className="link danger" onClick={() => void remove(flow.flow_id)}>
                delete
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
