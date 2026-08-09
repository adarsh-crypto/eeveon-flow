import { useEffect, useState } from 'react';
import type { Message, Response, VaultEntryMeta } from '../shared/messages';
import type { FlowDocument } from '../types/flow';

async function send(message: Message): Promise<Response> {
  return (await chrome.runtime.sendMessage(message)) as Response;
}

interface Props {
  flow: FlowDocument;
}

/**
 * Lets a secret variable this flow needs get a vault entry, so an automation can supply it
 * without anyone typing it in. Values never round-trip back to this UI once saved — only
 * "is something stored" is shown, never what.
 */
export default function VaultSection({ flow }: Props) {
  const secretVariables = flow.variables.filter((v) => v.kind === 'secret');
  const [entries, setEntries] = useState<VaultEntryMeta[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const response = await send({ kind: 'vault-list' });
    if (response.ok && 'entries' in response) setEntries(response.entries);
  };

  useEffect(() => {
    void refresh();
  }, [flow.flow_id]);

  if (secretVariables.length === 0) return null;

  const hasEntry = (variable: string) =>
    entries.some((e) => e.flow_id === flow.flow_id && e.variable === variable);

  const save = async (variable: string) => {
    const value = drafts[variable];
    if (!value) return;
    setBusy(variable);
    setError(null);
    const response = await send({ kind: 'vault-store-secret', flow_id: flow.flow_id, variable, value });
    setBusy(null);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setDrafts((prev) => ({ ...prev, [variable]: '' }));
    await refresh();
  };

  const remove = async (variable: string) => {
    setBusy(variable);
    await send({ kind: 'vault-delete-secret', flow_id: flow.flow_id, variable });
    setBusy(null);
    await refresh();
  };

  return (
    <div className="vault-section">
      <h2>Secrets</h2>
      <p className="meta">
        Stored encrypted on this device, needed for this flow to run as an unattended automation.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="vault-rows">
        {secretVariables.map((variable) => (
          <div key={variable.name} className="vault-row">
            <span className="vault-row-label">{variable.label}</span>
            {hasEntry(variable.name) ? (
              <span className="pill pill-low">stored</span>
            ) : (
              <span className="pill pill-medium">not set</span>
            )}
            <input
              type="password"
              placeholder={hasEntry(variable.name) ? 'replace value' : 'value'}
              value={drafts[variable.name] ?? ''}
              onChange={(event) => setDrafts((prev) => ({ ...prev, [variable.name]: event.target.value }))}
            />
            <button
              className="button"
              disabled={busy === variable.name || !drafts[variable.name]}
              onClick={() => void save(variable.name)}
            >
              Save
            </button>
            {hasEntry(variable.name) && (
              <button className="button button-danger" disabled={busy === variable.name} onClick={() => void remove(variable.name)}>
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
