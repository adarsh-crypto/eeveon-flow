import { useEffect, useState } from 'react';
import type { Message, Response } from '../shared/messages';
import type { FlowDocument } from '../types/flow';
import type { Automation, AutomationRun, AutomationSchedule } from '../types/automation';

async function send(message: Message): Promise<Response> {
  return (await chrome.runtime.sendMessage(message)) as Response;
}

interface Props {
  flow: FlowDocument;
}

const hasHighRisk = (flow: FlowDocument) => flow.steps.some((s) => s.risk === 'high');

export default function AutomationSection({ flow }: Props) {
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [name, setName] = useState(`${flow.name} — scheduled`);
  const [scheduleKind, setScheduleKind] = useState<'interval' | 'daily'>('interval');
  const [everyMinutes, setEveryMinutes] = useState(60);
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [autoApprove, setAutoApprove] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; reason: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedRuns, setExpandedRuns] = useState<Record<string, AutomationRun[]>>({});

  const refresh = async () => {
    const response = await send({ kind: 'automation-list' });
    if (response.ok && 'automations' in response) {
      setAutomations(response.automations.filter((a) => a.flow_id === flow.flow_id));
    }
  };

  useEffect(() => {
    void refresh();
  }, [flow.flow_id]);

  useEffect(() => {
    if (hasHighRisk(flow)) {
      setCheck({ ok: false, reason: 'this flow has a high-risk step — it can never be scheduled' });
      return;
    }
    void send({ kind: 'automation-can-schedule', flow_id: flow.flow_id, auto_approve_checkpoints: autoApprove }).then(
      (response) => {
        if (response.ok && 'can_schedule' in response) setCheck({ ok: response.can_schedule, reason: response.reason });
      },
    );
  }, [flow.flow_id, autoApprove]);

  const schedule: AutomationSchedule =
    scheduleKind === 'interval' ? { kind: 'interval', every_minutes: everyMinutes } : { kind: 'daily', hour, minute };

  const create = async () => {
    setError(null);
    const response = await send({
      kind: 'automation-create',
      flow_id: flow.flow_id,
      name,
      schedule,
      auto_approve_checkpoints: autoApprove,
    });
    if (!response.ok) {
      setError(response.error);
      return;
    }
    await refresh();
  };

  const toggle = async (automationId: string, enabled: boolean) => {
    await send({ kind: 'automation-set-enabled', automation_id: automationId, enabled });
    await refresh();
  };

  const remove = async (automationId: string) => {
    await send({ kind: 'automation-delete', automation_id: automationId });
    await refresh();
  };

  const toggleRuns = async (automationId: string) => {
    if (expandedRuns[automationId]) {
      setExpandedRuns((prev) => {
        const next = { ...prev };
        delete next[automationId];
        return next;
      });
      return;
    }
    const response = await send({ kind: 'automation-list-runs', automation_id: automationId });
    if (response.ok && 'runs' in response) {
      setExpandedRuns((prev) => ({ ...prev, [automationId]: response.runs }));
    }
  };

  return (
    <div className="automation-section">
      <h2>Automations</h2>

      {automations.length > 0 && (
        <ul className="automation-list">
          {automations.map((automation) => (
            <li key={automation.automation_id} className="automation-item">
              <div className="automation-item-head">
                <span className="automation-name">{automation.name}</span>
                <span className="label">{describeSchedule(automation.schedule)}</span>
              </div>
              <div className="automation-item-actions">
                <label className="automation-toggle">
                  <input
                    type="checkbox"
                    checked={automation.enabled}
                    onChange={(event) => void toggle(automation.automation_id, event.target.checked)}
                  />
                  enabled
                </label>
                <button className="button" onClick={() => void toggleRuns(automation.automation_id)}>
                  {expandedRuns[automation.automation_id] ? 'Hide history' : 'History'}
                </button>
                <button className="button button-danger" onClick={() => void remove(automation.automation_id)}>
                  Delete
                </button>
              </div>
              {expandedRuns[automation.automation_id] && (
                <ul className="run-history">
                  {expandedRuns[automation.automation_id]!.length === 0 && (
                    <li className="meta">No runs yet.</li>
                  )}
                  {expandedRuns[automation.automation_id]!.map((run, i) => (
                    <li key={i} className={`run-history-item run-history-${run.status}`}>
                      <span className="pill">{run.status}</span>
                      <span className="meta">{new Date(run.at).toLocaleString()}</span>
                      {run.message && <span className="meta">{run.message}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="automation-form">
        <label className="run-input">
          <span className="label">Name</span>
          <input type="text" value={name} onChange={(event) => setName(event.target.value)} />
        </label>

        <div className="schedule-kind">
          <label>
            <input
              type="radio"
              checked={scheduleKind === 'interval'}
              onChange={() => setScheduleKind('interval')}
            />
            Every N minutes
          </label>
          <label>
            <input type="radio" checked={scheduleKind === 'daily'} onChange={() => setScheduleKind('daily')} />
            Daily at a time
          </label>
        </div>

        {scheduleKind === 'interval' ? (
          <label className="run-input">
            <span className="label">Every (minutes)</span>
            <input
              type="text"
              inputMode="numeric"
              value={everyMinutes}
              onChange={(event) => setEveryMinutes(Math.max(1, Number(event.target.value) || 1))}
            />
          </label>
        ) : (
          <div className="daily-time">
            <label className="run-input">
              <span className="label">Hour (0-23)</span>
              <input
                type="text"
                inputMode="numeric"
                value={hour}
                onChange={(event) => setHour(clamp(Number(event.target.value) || 0, 0, 23))}
              />
            </label>
            <label className="run-input">
              <span className="label">Minute (0-59)</span>
              <input
                type="text"
                inputMode="numeric"
                value={minute}
                onChange={(event) => setMinute(clamp(Number(event.target.value) || 0, 0, 59))}
              />
            </label>
          </div>
        )}

        {flow.checkpoints.length > 0 && (
          <label className="auto-approve-row">
            <input type="checkbox" checked={autoApprove} onChange={(event) => setAutoApprove(event.target.checked)} />
            Auto-approve this flow's checkpoints when run as an automation — nobody will be
            there to click Approve.
          </label>
        )}

        {check && !check.ok && <p className="error">{check.reason}</p>}
        {error && <p className="error">{error}</p>}

        <button className="button button-primary" disabled={!check?.ok} onClick={() => void create()}>
          Schedule this flow
        </button>
      </div>
    </div>
  );
}

function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.kind === 'interval') return `every ${schedule.every_minutes}m`;
  const hh = String(schedule.hour).padStart(2, '0');
  const mm = String(schedule.minute).padStart(2, '0');
  return `daily at ${hh}:${mm}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
