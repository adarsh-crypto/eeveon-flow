/**
 * Flow JSON → SKILL.md.
 *
 * A one-way projection for agent runtimes (Claude Code and anything else that reads a
 * markdown skill). Lossy by design: timing and provenance are dropped, prose is added.
 * Nothing reconstructs a Flow from this file.
 */
import type { Checkpoint, FlowDocument, FlowStep } from '../types/flow';

export function exportSkillMd(flow: FlowDocument): string {
  const checkpointsByStep = new Map<string, Checkpoint>();
  for (const checkpoint of flow.checkpoints) checkpointsByStep.set(checkpoint.before_step, checkpoint);

  const lines: string[] = [];

  lines.push('---');
  lines.push(`name: ${yamlString(flow.name)}`);
  lines.push(`description: ${yamlString(flow.description ?? autoDescription(flow))}`);
  lines.push(`source: eeveon-flow ${flow.provenance.recorder_version}`);
  lines.push(`flow_id: ${flow.flow_id}`);
  lines.push(`recorded_at: ${flow.created_at}`);
  lines.push(`origin: ${yamlString(flow.origin.url)}`);
  if (flow.variables.length > 0) {
    lines.push('inputs:');
    for (const variable of flow.variables) {
      lines.push(`  - name: ${variable.name}`);
      lines.push(`    label: ${yamlString(variable.label)}`);
      lines.push(`    kind: ${variable.kind}`);
      lines.push(`    required: ${variable.required}`);
      if (variable.default !== null) lines.push(`    default: ${yamlString(variable.default)}`);
    }
  }
  lines.push('---');
  lines.push('');

  lines.push(`# ${flow.name}`);
  lines.push('');
  lines.push(
    `Recorded on ${flow.origin.host}. ${flow.steps.length} step${flow.steps.length === 1 ? '' : 's'}` +
      (flow.checkpoints.length > 0 ? `, ${flow.checkpoints.length} requiring approval.` : '.'),
  );
  lines.push('');

  if (flow.variables.length > 0) {
    lines.push('## Inputs');
    lines.push('');
    for (const variable of flow.variables) {
      const detail =
        variable.kind === 'secret'
          ? '**secret** — ask the operator, never hard-code it'
          : variable.default !== null
            ? `defaults to \`${variable.default}\``
            : 'required';
      lines.push(`- \`${variable.name}\` — ${variable.label} (${detail})`);
    }
    lines.push('');
  }

  lines.push('## Steps');
  lines.push('');
  for (const step of flow.steps) {
    const checkpoint = checkpointsByStep.get(step.step_id);
    if (checkpoint) {
      lines.push(
        `> **Stop and get approval** (${checkpoint.severity}): this step ${checkpoint.reason}. ` +
          'Do not continue until a human confirms.',
      );
      lines.push('');
    }
    lines.push(`### ${step.index + 1}. ${step.intent}`);
    lines.push('');
    lines.push(`- verb: \`${step.verb}\``);
    if (step.target) lines.push(`- target: ${targetLine(step)}`);
    if (step.url) lines.push(`- url: ${step.url}`);
    if (step.value) lines.push(`- value: ${valueLine(step)}`);
    if (step.collapsed_from > 1) lines.push(`- folded from ${step.collapsed_from} raw events`);
    lines.push('');
  }

  lines.push('## Notes');
  lines.push('');
  lines.push('- Selectors are listed best-first. Try each in order; if none match, stop and report.');
  lines.push('- Never substitute a coordinate click for a failed selector.');
  if (flow.variables.some((v) => v.kind === 'secret')) {
    lines.push('- Secret inputs were never recorded. Request them at run time and do not log them.');
  }
  lines.push('');

  return lines.join('\n');
}

function targetLine(step: FlowStep): string {
  const target = step.target!;
  const described = target.name ? `${target.role ?? target.tag} "${target.name}"` : `<${target.tag}>`;
  const selectors = target.selectors.map((s) => `\`${s.strategy}=${s.value}\``).join(', ');
  return `${described} — ${selectors}`;
}

function valueLine(step: FlowStep): string {
  const value = step.value!;
  if (value.kind === 'literal') return `\`${value.text}\``;
  if (value.kind === 'variable') return `\`{{${value.variable}}}\``;
  return `\`{{${value.variable}}}\` (secret — supplied at run time)`;
}

function autoDescription(flow: FlowDocument): string {
  return `Replay a recorded ${flow.origin.host} workflow: ${flow.steps
    .slice(0, 3)
    .map((s) => s.intent.toLowerCase())
    .join(', then ')}.`;
}

function yamlString(text: string): string {
  return JSON.stringify(text);
}
