/**
 * Semantic selector extraction. Runs in the page, so it must be dependency-free and cheap.
 *
 * Rule F5 of the schema: coordinates never enter a selector. There is no code path here
 * that reads getBoundingClientRect, clientX, or offsetTop.
 */
import { SELECTOR_SCORE, type SelectorStrategy } from '../types/primitives';
import type { Selector } from '../types/flow';

const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

/** Roles we can infer without a full accessibility-tree computation. */
const IMPLICIT_ROLES: Record<string, string> = {
  a: 'link',
  button: 'button',
  select: 'combobox',
  textarea: 'textbox',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
  img: 'img',
  nav: 'navigation',
  form: 'form',
  table: 'table',
};

const INPUT_TYPE_ROLES: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  search: 'searchbox',
  text: 'textbox',
  email: 'textbox',
  tel: 'textbox',
  url: 'textbox',
  number: 'spinbutton',
};

export function elementRole(el: Element): string | null {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.trim().split(/\s+/)[0] ?? null;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    return INPUT_TYPE_ROLES[type] ?? 'textbox';
  }
  return IMPLICIT_ROLES[tag] ?? null;
}

/** Trim and collapse whitespace; empty becomes null. */
function clean(text: string | null | undefined): string | null {
  if (!text) return null;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : null;
}

/** Accessible name, approximated: aria-label → aria-labelledby → label → placeholder → text. */
export function accessibleName(el: Element): string | null {
  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return aria;

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => clean(el.ownerDocument.getElementById(id)?.textContent))
      .filter((t): t is string => t !== null);
    if (parts.length > 0) return parts.join(' ');
  }

  const labelled = labelText(el);
  if (labelled) return labelled;

  const placeholder = clean(el.getAttribute('placeholder'));
  if (placeholder) return placeholder;

  const title = clean(el.getAttribute('title'));
  if (title) return title;

  const alt = clean(el.getAttribute('alt'));
  if (alt) return alt;

  const own = clean(el.textContent);
  // Long text is page copy, not a name.
  if (own && own.length <= 80) return own;

  return null;
}

function labelText(el: Element): string | null {
  const id = el.getAttribute('id');
  if (id) {
    // CSS.escape keeps ids containing ':' or '.' (Tailwind, Angular) from breaking the query.
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
    const forLabel = el.ownerDocument.querySelector(`label[for="${escaped}"]`);
    const text = clean(forLabel?.textContent);
    if (text) return text;
  }
  const wrapping = el.closest('label');
  if (wrapping) {
    const text = clean(wrapping.textContent);
    if (text) return text;
  }
  return null;
}

function testId(el: Element): string | null {
  for (const attr of TESTID_ATTRS) {
    const value = clean(el.getAttribute(attr));
    if (value) return value;
  }
  return null;
}

/**
 * A structural fallback. Kept short and class-free: generated class names (CSS modules,
 * Tailwind JIT, styled-components) change on every build and make a selector look stable
 * while being the most brittle thing in the file.
 */
export function cssPath(el: Element, maxDepth = 4): string {
  const parts: string[] = [];
  let current: Element | null = el;
  let depth = 0;

  while (current && depth < maxDepth && current.tagName.toLowerCase() !== 'html') {
    const tag = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter((c) => c.tagName === current!.tagName);
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(current) + 1})` : tag);
    current = parent;
    depth += 1;
  }
  return parts.join(' > ');
}

function push(out: Selector[], strategy: SelectorStrategy, value: string | null): void {
  if (!value) return;
  out.push({ strategy, value, score: SELECTOR_SCORE[strategy] });
}

/**
 * Build the ordered selector list for an element. Best-first; the runner tries them in
 * order and the exporters read index 0 as the primary.
 */
export function buildSelectors(el: Element): Selector[] {
  const out: Selector[] = [];
  const role = elementRole(el);
  const name = accessibleName(el);

  push(out, 'testid', testId(el));
  if (role && name) push(out, 'role', `${role}[name="${name}"]`);
  push(out, 'label', labelText(el));

  // Visible text is only a useful handle for things a user clicks.
  const tag = el.tagName.toLowerCase();
  if (tag === 'a' || tag === 'button' || role === 'button' || role === 'link') {
    const text = clean(el.textContent);
    if (text && text.length <= 80) push(out, 'text', text);
  }

  push(out, 'name', el.getAttribute('name'));

  const id = el.getAttribute('id');
  // Framework-generated ids (react-aria :r0:, Angular ng-, Vue data-v-) are noise.
  if (id && !/^(:|ng-|data-v-|mui-|radix-|headlessui-)/.test(id) && !/\d{5,}/.test(id)) {
    push(out, 'id', id);
  }

  push(out, 'css', cssPath(el));

  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Stable-enough identity for folding consecutive events on the same element. */
export function nodeKey(el: Element): string {
  const selectors = buildSelectors(el);
  const best = selectors[0];
  return best ? `${best.strategy}:${best.value}` : `tag:${el.tagName.toLowerCase()}`;
}
