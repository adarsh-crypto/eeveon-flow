import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message, Response, SavedFlowSummary } from '../shared/messages';
import type { FlowDocument } from '../types/flow';
import { validateFlow, type Violation } from '../compile/validate';
import { exportFlow, type ExportFormat } from '../export';
import { downloadArtifact } from '../shared/download';
import RunPanel from '../sidepanel/RunPanel';
import TabPicker from './TabPicker';
import VaultSection from './VaultSection';
import AutomationSection from './AutomationSection';

async function send(message: Message): Promise<Response> {
  return (await chrome.runtime.sendMessage(message)) as Response;
}

export default function App() {
  const [flows, setFlows] = useState<SavedFlowSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<FlowDocument | null>(null);
  const [violations, setViolations] = useState<Violation[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [tabId, setTabId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refreshList = useCallback(async () => {
    const response = await send({ kind: 'list-flows' });
    if (response.ok && 'flows' in response) setFlows(response.flows);
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  useEffect(() => {
    if (!selectedId) {
      setSelected(null);
      return;
    }
    void send({ kind: 'get-flow', flow_id: selectedId }).then((response) => {
      if (response.ok && 'flow' in response) {
        setSelected(response.flow);
        setViolations(validateFlow(response.flow).violations);
        setNameDraft(response.flow.name);
      }
    });
  }, [selectedId]);

  const select = (flowId: string) => {
    setSelectedId(flowId);
    setRenaming(false);
    setNotice(null);
  };

  const remove = async (flowId: string) => {
    await send({ kind: 'delete-flow', flow_id: flowId });
    if (selectedId === flowId) setSelectedId(null);
    await refreshList();
  };

  const saveRename = async () => {
    if (!selected) return;
    const name = nameDraft.trim();
    if (!name) return;
    await send({ kind: 'rename-flow', flow_id: selected.flow_id, name });
    setRenaming(false);
    setSelected({ ...selected, name });
    await refreshList();
  };

  const download = (format: ExportFormat) => {
    if (!selected) return;
    downloadArtifact(exportFlow(selected, format));
  };

  const importFile = async (file: File) => {
    setNotice(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      setNotice({ kind: 'error', text: `"${file.name}" is not valid JSON` });
      return;
    }
    const response = await send({ kind: 'import-flow', flow: parsed });
    if (!response.ok) {
      setNotice({ kind: 'error', text: response.error });
      return;
    }
    setNotice({ kind: 'info', text: `Imported "${(parsed as FlowDocument).name}"` });
    await refreshList();
    if (response.ok && 'flow' in response) select(response.flow.flow_id);
  };

  const onFilePicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-importing the same file twice in a row
    if (file) void importFile(file);
  };

  return (
    <div className="dashboard">
      <header className="dash-header">
        <div className="brand">
          <span className="brand-mark">EE</span>
          <div>
            <h1>EEVEON Flow</h1>
            <p className="tagline">Manage every recorded workflow in one place.</p>
          </div>
        </div>
        <div className="dash-actions">
          <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={onFilePicked} />
          <button className="button" onClick={() => fileInput.current?.click()}>
            Import Flow
          </button>
        </div>
      </header>

      {notice && <p className={notice.kind === 'error' ? 'error' : 'notice'}>{notice.text}</p>}

      <div className="dash-body">
        <section className="flow-list">
          <h2>Saved flows ({flows.length})</h2>
          {flows.length === 0 && (
            <p className="empty">
              Nothing here yet. Record a workflow from the side panel, or import a Flow JSON file.
            </p>
          )}
          <div className="flow-cards">
            {flows.map((flow) => (
              <button
                key={flow.flow_id}
                className={`card flow-card ${flow.flow_id === selectedId ? 'flow-card-active' : ''}`}
                onClick={() => select(flow.flow_id)}
              >
                <span className="flow-card-name">{flow.name}</span>
                <span className="label">{flow.host}</span>
                <span className="meta">
                  {flow.step_count} steps · {new Date(flow.created_at).toLocaleDateString()}
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="flow-detail card">
          {!selected && <p className="empty">Select a flow to inspect, run, or export it.</p>}

          {selected && (
            <>
              <div className="detail-header">
                {renaming ? (
                  <div className="rename-row">
                    <input
                      type="text"
                      value={nameDraft}
                      onChange={(event) => setNameDraft(event.target.value)}
                      autoFocus
                    />
                    <button className="button button-primary" onClick={() => void saveRename()}>
                      Save
                    </button>
                    <button className="button" onClick={() => setRenaming(false)}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="rename-row">
                    <h2 className="flow-title">{selected.name}</h2>
                    <button className="button" onClick={() => setRenaming(true)}>
                      Rename
                    </button>
                    <button className="button button-danger" onClick={() => void remove(selected.flow_id)}>
                      Delete
                    </button>
                  </div>
                )}
                <p className="meta">
                  {selected.origin.host} · {selected.steps.length} steps · {selected.variables.length} inputs ·{' '}
                  {selected.checkpoints.length} approvals · recorded{' '}
                  {new Date(selected.created_at).toLocaleString()}
                </p>
              </div>

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
                    <span className={`pill pill-${step.risk}`}>{step.risk}</span>
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

              <VaultSection flow={selected} key={`vault:${selected.flow_id}`} />

              <AutomationSection flow={selected} key={`automation:${selected.flow_id}`} />

              <div className="run-section">
                <h2>Run once</h2>
                <TabPicker value={tabId} onChange={setTabId} />
                {tabId !== null ? (
                  <RunPanel flow={selected} tabId={tabId} key={`${selected.flow_id}:${tabId}`} />
                ) : (
                  <p className="empty">Open the page you want to run this against, then pick it above.</p>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
