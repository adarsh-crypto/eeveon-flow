import { describe, expect, it } from 'vitest';
import { compileFlow } from '../src/compile/compileFlow';
import { exportFlow, exportPlaywright, exportSkillMd } from '../src/export';
import { validateFlow } from '../src/compile/validate';
import { searchSession, passwordBox, TEST_T0 } from './fixtures/search-recording';

const OPTIONS = { now: () => TEST_T0, idFactory: () => 'flow-fixed-id' };
const flow = compileFlow(searchSession(), OPTIONS);

const secretFlow = compileFlow(
  {
    session_id: 's',
    tab_id: 1,
    started_at: TEST_T0,
    origin_url: 'https://app.test/login',
    origin_host: 'app.test',
    origin_title: 'Login',
    events: [
      { type: 'pageload', at: TEST_T0, url: 'https://app.test/login', title: 'Login', target: null },
      { type: 'input', at: TEST_T0 + 500, url: 'https://app.test/login', title: 'Login', target: passwordBox },
    ],
  },
  OPTIONS,
);

describe('SKILL.md export', () => {
  const markdown = exportSkillMd(flow);

  it('opens with YAML frontmatter carrying the inputs', () => {
    expect(markdown.startsWith('---\n')).toBe(true);
    expect(markdown).toContain('inputs:');
    expect(markdown).toContain(`flow_id: ${flow.flow_id}`);
  });

  it('writes one heading per step, in order', () => {
    const headings = [...markdown.matchAll(/^### (\d+)\./gm)].map((m) => Number(m[1]));
    expect(headings).toEqual(flow.steps.map((_, i) => i + 1));
  });

  it('renders an approval stop before a checkpointed step', () => {
    expect(markdown).toContain('**Stop and get approval**');
  });

  it('tells the agent to request secrets at run time and never logs one', () => {
    const secretMarkdown = exportSkillMd(secretFlow);
    expect(secretMarkdown).toContain('Request them at run time');
    expect(secretMarkdown).not.toContain('hunter2');
  });
});

describe('Playwright export', () => {
  const script = exportPlaywright(flow);

  it('emits a single test with one comment per step', () => {
    expect(script).toContain("import { test, expect } from '@playwright/test';");
    for (const step of flow.steps) {
      expect(script).toContain(`// ${step.index + 1}. ${step.intent}`);
    }
  });

  it('maps the highest-priority selector onto a semantic locator', () => {
    // The fixture's search box has a data-testid, the link has a role+name.
    expect(script).toContain('page.getByTestId("search-box")');
    expect(script).toContain('page.getByRole("link", { name: "Half-Life 2" })');
  });

  it('never falls back to coordinates', () => {
    expect(script).not.toMatch(/mouse\.(click|move)\(\s*\d/);
  });

  it('reads secrets from the environment and fails fast when missing', () => {
    const secretScript = exportPlaywright(secretFlow);
    expect(secretScript).toContain('requireEnv(');
    expect(secretScript).toContain('missing required secret');
  });

  it('uses the recorded value as the default for a text input', () => {
    expect(script).toContain('"half-life"');
    expect(script).toMatch(/inputs\.\w+/);
  });
});

describe('exportFlow', () => {
  it('names each artifact after the flow', () => {
    expect(exportFlow(flow, 'json').filename).toMatch(/\.flow\.json$/);
    expect(exportFlow(flow, 'skill').filename).toMatch(/\.SKILL\.md$/);
    expect(exportFlow(flow, 'playwright').filename).toMatch(/\.spec\.ts$/);
  });

  it('round-trips the JSON export back through the validator', () => {
    const parsed: unknown = JSON.parse(exportFlow(flow, 'json').content);
    expect(validateFlow(parsed).valid).toBe(true);
  });
});
