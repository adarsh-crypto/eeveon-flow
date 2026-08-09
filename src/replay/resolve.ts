/**
 * Selector resolution — the inverse of src/record/selectors.ts. That module turns an
 * element into a ranked Selector[]; this one turns a Selector[] back into an element in
 * whatever page the flow is replaying against.
 *
 * Runs in the content script, so it must stay dependency-free (only type-only imports from
 * zod-backed modules, which vite/tsc erase at build time).
 */
import { accessibleName, elementRole } from '../record/selectors';
import type { Selector } from '../types/flow';

const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

export interface ResolveResult {
  element: Element | null;
  tried: string[];
}

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  if (el.offsetParent !== null) return true;
  // offsetParent is null for fixed-position elements too; fall back to a rect check.
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function escapeAttr(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function byTestId(value: string): Element | null {
  for (const attr of TESTID_ATTRS) {
    const el = document.querySelector(`[${attr}="${escapeAttr(value)}"]`);
    if (el && isVisible(el)) return el;
  }
  return null;
}

function byRole(value: string): Element | null {
  const match = /^([a-z]+)\[name="(.*)"\]$/s.exec(value);
  if (!match) return null;
  const [, role, name] = match;
  for (const el of document.querySelectorAll<HTMLElement>('*')) {
    if (!isVisible(el)) continue;
    if (elementRole(el) === role && accessibleName(el) === name) return el;
  }
  return null;
}

function byLabel(value: string): Element | null {
  for (const label of document.querySelectorAll('label')) {
    if (label.textContent?.replace(/\s+/g, ' ').trim() !== value) continue;
    const forId = label.getAttribute('for');
    if (forId) {
      const target = document.getElementById(forId);
      if (target && isVisible(target)) return target;
    }
    const nested = label.querySelector('input, select, textarea, button');
    if (nested && isVisible(nested)) return nested;
  }
  return null;
}

function byText(value: string): Element | null {
  for (const el of document.querySelectorAll<HTMLElement>('a, button, [role="button"], [role="link"]')) {
    if (!isVisible(el)) continue;
    if (el.textContent?.replace(/\s+/g, ' ').trim() === value) return el;
  }
  return null;
}

function byName(value: string): Element | null {
  const el = document.querySelector(`[name="${escapeAttr(value)}"]`);
  return el && isVisible(el) ? el : null;
}

function byId(value: string): Element | null {
  const el = document.getElementById(value);
  return el && isVisible(el) ? el : null;
}

function byCss(value: string): Element | null {
  try {
    const el = document.querySelector(value);
    return el && isVisible(el) ? el : null;
  } catch {
    return null; // a css selector recorded on a different page shape may not even parse
  }
}

const RESOLVERS: Record<Selector['strategy'], (value: string) => Element | null> = {
  testid: byTestId,
  role: byRole,
  label: byLabel,
  text: byText,
  name: byName,
  id: byId,
  css: byCss,
};

/** Tries each selector in the recorded best-first order; returns the first live match. */
export function resolveTarget(selectors: Selector[]): ResolveResult {
  const tried: string[] = [];
  for (const selector of selectors) {
    tried.push(`${selector.strategy}=${selector.value}`);
    const element = RESOLVERS[selector.strategy](selector.value);
    if (element) return { element, tried };
  }
  return { element: null, tried };
}
