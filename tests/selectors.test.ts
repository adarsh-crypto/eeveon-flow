/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { accessibleName, buildSelectors, cssPath, elementRole } from '../src/record/selectors';

function mount(html: string): Element {
  document.body.innerHTML = html;
  const el = document.body.querySelector('[data-subject]');
  if (!el) throw new Error('fixture needs a [data-subject] element');
  return el;
}

describe('elementRole', () => {
  it('prefers an explicit role', () => {
    expect(elementRole(mount('<div data-subject role="button">Go</div>'))).toBe('button');
  });

  it('infers a role from the tag', () => {
    expect(elementRole(mount('<a data-subject href="/x">Go</a>'))).toBe('link');
  });

  it('infers a role from the input type', () => {
    expect(elementRole(mount('<input data-subject type="search" />'))).toBe('searchbox');
    expect(elementRole(mount('<input data-subject type="checkbox" />'))).toBe('checkbox');
  });
});

describe('accessibleName', () => {
  it('prefers aria-label', () => {
    expect(accessibleName(mount('<input data-subject aria-label="Search games" placeholder="p" />'))).toBe(
      'Search games',
    );
  });

  it('falls back to an associated label', () => {
    expect(
      accessibleName(mount('<label for="q">Search</label><input data-subject id="q" />')),
    ).toBe('Search');
  });

  it('falls back to placeholder, then to short text', () => {
    expect(accessibleName(mount('<input data-subject placeholder="Type here" />'))).toBe('Type here');
    expect(accessibleName(mount('<button data-subject>Submit order</button>'))).toBe('Submit order');
  });

  it('ignores long body copy as a name', () => {
    const long = 'x'.repeat(200);
    expect(accessibleName(mount(`<div data-subject>${long}</div>`))).toBeNull();
  });
});

describe('buildSelectors', () => {
  it('ranks a test id first', () => {
    const selectors = buildSelectors(mount('<input data-subject data-testid="search-box" name="q" id="q" />'));
    expect(selectors[0]).toMatchObject({ strategy: 'testid', value: 'search-box' });
  });

  it('ranks role+name above name and id', () => {
    const selectors = buildSelectors(mount('<button data-subject name="go" id="go">Search</button>'));
    expect(selectors[0]?.strategy).toBe('role');
    expect(selectors[0]?.value).toBe('button[name="Search"]');
  });

  it('skips framework-generated ids', () => {
    const selectors = buildSelectors(mount('<input data-subject id="radix-1234567" />'));
    expect(selectors.some((s) => s.strategy === 'id')).toBe(false);
  });

  it('always offers a css fallback and never a coordinate', () => {
    const selectors = buildSelectors(mount('<div data-subject></div>'));
    expect(selectors.at(-1)?.strategy).toBe('css');
    expect(selectors.every((s) => !/\b(x|y|left|top)\s*[:=]\s*\d/.test(s.value))).toBe(true);
  });

  it('is ordered best-first by score', () => {
    const selectors = buildSelectors(
      mount('<label for="e">Email</label><input data-subject data-testid="e-field" id="e" name="email" />'),
    );
    const scores = selectors.map((s) => s.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });
});

describe('cssPath', () => {
  it('uses nth-of-type only when siblings collide', () => {
    const el = mount('<ul><li>a</li><li data-subject>b</li></ul>');
    expect(cssPath(el)).toContain('li:nth-of-type(2)');
  });

  it('stays shallow', () => {
    const el = mount('<div><div><div><div><span data-subject>x</span></div></div></div></div>');
    expect(cssPath(el).split('>').length).toBeLessThanOrEqual(4);
  });
});
