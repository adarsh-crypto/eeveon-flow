import { useEffect, useState } from 'react';

interface Props {
  value: number | null;
  onChange: (tabId: number) => void;
}

interface TabOption {
  id: number;
  title: string;
  host: string;
}

/**
 * The dashboard is itself a browser tab, so "run against the active tab" (which works fine
 * for the side panel) would target the dashboard page itself. This lets the user name the
 * actual page to run against.
 */
export default function TabPicker({ value, onChange }: Props) {
  const [options, setOptions] = useState<TabOption[]>([]);

  const refresh = async () => {
    const own = await chrome.tabs.getCurrent();
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    const next: TabOption[] = [];
    for (const tab of tabs) {
      if (tab.id === undefined || tab.id === own?.id) continue;
      let host = '';
      try {
        host = tab.url ? new URL(tab.url).host : '';
      } catch {
        host = '';
      }
      next.push({ id: tab.id, title: tab.title ?? tab.url ?? `tab ${tab.id}`, host });
    }
    setOptions(next);
    if (value === null && next.length > 0) onChange(next[0]!.id);
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="tab-picker">
      <label>
        <span className="label">Run against</span>
        <select
          value={value ?? ''}
          onChange={(event) => onChange(Number(event.target.value))}
          disabled={options.length === 0}
        >
          {options.length === 0 && <option value="">no open pages found</option>}
          {options.map((tab) => (
            <option key={tab.id} value={tab.id}>
              {tab.title} — {tab.host}
            </option>
          ))}
        </select>
      </label>
      <button className="button" onClick={() => void refresh()} type="button">
        Refresh tabs
      </button>
    </div>
  );
}
