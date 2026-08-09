import { describe, expect, it } from 'vitest';
import { toCanonical } from '../src/normalize/canonical';
import { collapse } from '../src/normalize/collapse';
import { searchEvents, searchBox, resultLink, TEST_T0 } from './fixtures/search-recording';
import type { RawEvent } from '../src/types/capture';

describe('toCanonical', () => {
  it('maps raw events to verbs without grouping them', () => {
    const canonical = toCanonical(searchEvents);
    // 9 typing events survive as 9 separate `type` events at this stage.
    expect(canonical.filter((e) => e.verb === 'type')).toHaveLength(9);
    expect(canonical.every((e) => e.raw_count === 1)).toBe(true);
  });

  it('drops a same-URL navigation as noise', () => {
    const events: RawEvent[] = [
      { type: 'pageload', at: 1, url: 'https://a.test/', title: 'A', target: null },
      { type: 'navigate', at: 2, url: 'https://a.test/', title: 'A', target: null },
    ];
    expect(toCanonical(events).filter((e) => e.verb === 'navigate')).toHaveLength(1);
  });

  it('treats a checkbox click as a selection, not a click', () => {
    const events: RawEvent[] = [
      {
        type: 'click',
        at: 1,
        url: 'https://a.test/',
        title: 'A',
        target: {
          tag: 'input',
          role: 'checkbox',
          name: 'Remember me',
          selectors: [{ strategy: 'label', value: 'Remember me', score: 80 }],
          secret: false,
          input_type: 'checkbox',
          node_key: 'label:Remember me',
        },
      },
    ];
    expect(toCanonical(events)[0]?.verb).toBe('select');
  });

  it('ignores clicks on background elements with only a css selector', () => {
    const events: RawEvent[] = [
      {
        type: 'click',
        at: 1,
        url: 'https://a.test/',
        title: 'A',
        target: {
          tag: 'div',
          role: null,
          name: null,
          selectors: [{ strategy: 'css', value: 'body > div', score: 30 }],
          secret: false,
          input_type: null,
          node_key: 'css:body > div',
        },
      },
    ];
    expect(toCanonical(events)).toHaveLength(0);
  });

  it('does not double-count a change event on a text field', () => {
    const events: RawEvent[] = [
      { type: 'input', at: 1, url: 'https://a.test/', title: 'A', target: searchBox, text: 'x' },
      { type: 'change', at: 2, url: 'https://a.test/', title: 'A', target: searchBox, text: 'x' },
    ];
    expect(toCanonical(events)).toHaveLength(1);
  });
});

describe('collapse', () => {
  const canonical = toCanonical(searchEvents);
  const steps = collapse(canonical);

  it('preserves every raw event it was given', () => {
    const before = canonical.reduce((sum, e) => sum + e.raw_count, 0);
    const after = steps.reduce((sum, e) => sum + e.raw_count, 0);
    expect(after).toBe(before);
  });

  it('folds nine keystrokes into one type step holding the final value', () => {
    const typeSteps = steps.filter((s) => s.verb === 'type');
    expect(typeSteps).toHaveLength(1);
    expect(typeSteps[0]?.text).toBe('half-life');
    expect(typeSteps[0]?.raw_count).toBe(9);
  });

  it('turns Enter after typing into a submit rather than a keypress', () => {
    expect(steps.some((s) => s.verb === 'key_press')).toBe(false);
    expect(steps.filter((s) => s.verb === 'submit')).toHaveLength(1);
  });

  it('attaches a click-caused navigation to the click instead of emitting a step', () => {
    const click = steps.find((s) => s.target?.node_key === resultLink.node_key);
    expect(click?.verb).toBe('click');
    expect(click?.url).toBe('https://steamcharts.com/app/220');
    expect(steps.filter((s) => s.verb === 'navigate')).toHaveLength(1); // only the initial load
  });

  it('drops trailing scroll noise but credits its raw events', () => {
    const trailing = collapse(
      toCanonical([
        { type: 'pageload', at: TEST_T0, url: 'https://a.test/', title: 'A', target: null },
        { type: 'click', at: TEST_T0 + 100, url: 'https://a.test/', title: 'A', target: resultLink },
        { type: 'scroll', at: TEST_T0 + 9_000, url: 'https://a.test/', title: 'A', target: null },
      ]),
    );
    expect(trailing.map((s) => s.verb)).toEqual(['navigate', 'click']);
    expect(trailing.reduce((sum, s) => sum + s.raw_count, 0)).toBe(3);
  });

  it('does not fold typing separated by a long pause into one step', () => {
    const events: RawEvent[] = [
      { type: 'input', at: 0, url: 'https://a.test/', title: 'A', target: searchBox, text: 'a' },
      { type: 'input', at: 60_000, url: 'https://a.test/', title: 'A', target: searchBox, text: 'ab' },
    ];
    expect(collapse(toCanonical(events))).toHaveLength(2);
  });
});
