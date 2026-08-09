import type { FlowDocument } from '../types/flow';
import { exportSkillMd } from './skillMd';
import { exportPlaywright } from './playwright';

export type ExportFormat = 'json' | 'skill' | 'playwright';

export interface ExportArtifact {
  filename: string;
  mimeType: string;
  content: string;
}

export function exportFlow(flow: FlowDocument, format: ExportFormat): ExportArtifact {
  const stem = slugify(flow.name) || 'flow';
  switch (format) {
    case 'json':
      return {
        filename: `${stem}.flow.json`,
        mimeType: 'application/json',
        content: JSON.stringify(flow, null, 2),
      };
    case 'skill':
      return { filename: `${stem}.SKILL.md`, mimeType: 'text/markdown', content: exportSkillMd(flow) };
    case 'playwright':
      return {
        filename: `${stem}.spec.ts`,
        mimeType: 'text/plain',
        content: exportPlaywright(flow),
      };
    default: {
      const never: never = format;
      throw new Error(`unknown export format: ${String(never)}`);
    }
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export { exportSkillMd, exportPlaywright };
