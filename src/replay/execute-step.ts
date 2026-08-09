/**
 * Executes one step against the live page. Runs in the content script.
 *
 * `navigate` is not handled here — the background performs it directly via
 * chrome.tabs.update, because a navigation destroys this content script's own execution
 * context before it could report success.
 */
import { resolveTarget } from './resolve';
import type { ReplayActionPayload, StepResult } from './actionPayload';

const ACTION_SETTLE_MS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * React (and most modern frameworks) wrap the native `value` setter to detect programmatic
 * writes and ignore them. Going through the native prototype setter first, then dispatching
 * `input`, is the same technique browser-testing tools use to make a framework's own change
 * handler fire.
 */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
  descriptor?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function requireTarget(payload: ReplayActionPayload): { element: Element } | { error: StepResult } {
  const { element, tried } = resolveTarget(payload.target?.selectors ?? []);
  if (!element) {
    return { error: { ok: false, error: 'no selector resolved to a live element', tried } };
  }
  return { element };
}

async function doClick(payload: ReplayActionPayload): Promise<StepResult> {
  const found = requireTarget(payload);
  if ('error' in found) return found.error;
  found.element.scrollIntoView({ block: 'center', behavior: 'instant' });
  await sleep(ACTION_SETTLE_MS);
  if (found.element instanceof HTMLElement) {
    found.element.click();
  } else {
    found.element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }
  return { ok: true };
}

async function doType(payload: ReplayActionPayload): Promise<StepResult> {
  const found = requireTarget(payload);
  if ('error' in found) return found.error;
  const el = found.element;
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
    return { ok: false, error: `resolved element is <${el.tagName.toLowerCase()}>, not a text input` };
  }
  el.focus();
  setNativeValue(el, payload.text ?? '');
  return { ok: true };
}

async function doSelect(payload: ReplayActionPayload): Promise<StepResult> {
  const found = requireTarget(payload);
  if ('error' in found) return found.error;
  const el = found.element;

  if (el instanceof HTMLSelectElement) {
    el.value = payload.text ?? '';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    if (!el.checked) el.click();
    return { ok: true };
  }

  return { ok: false, error: `resolved element is <${el.tagName.toLowerCase()}>, not a select/checkbox/radio` };
}

async function doSubmit(payload: ReplayActionPayload): Promise<StepResult> {
  const found = requireTarget(payload);
  if ('error' in found) return found.error;
  const el = found.element;

  const form = el instanceof HTMLFormElement ? el : el.closest('form');
  if (form) {
    form.requestSubmit();
    return { ok: true };
  }

  if (el instanceof HTMLElement) {
    // No enclosing form (SPA search boxes, custom widgets) — Enter is the recorded action.
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    return { ok: true };
  }

  return { ok: false, error: 'submit target is neither a form nor focusable' };
}

async function doKeyPress(payload: ReplayActionPayload): Promise<StepResult> {
  const key = (payload.text ?? 'Enter').split('+').pop() ?? 'Enter';
  const target: Element = payload.target
    ? (resolveTarget(payload.target.selectors).element ?? document.activeElement ?? document.body)
    : (document.activeElement ?? document.body);
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
  return { ok: true };
}

async function doScroll(): Promise<StepResult> {
  window.scrollBy({ top: 600, behavior: 'instant' });
  return { ok: true };
}

async function doHover(payload: ReplayActionPayload): Promise<StepResult> {
  const found = requireTarget(payload);
  if ('error' in found) return found.error;
  found.element.scrollIntoView({ block: 'center', behavior: 'instant' });
  found.element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  found.element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  return { ok: true };
}

/** No reliable networkidle signal from inside a content script; a fixed settle is the MVP answer. */
async function doWait(): Promise<StepResult> {
  await sleep(500);
  return { ok: true };
}

async function doAssert(payload: ReplayActionPayload): Promise<StepResult> {
  const found = requireTarget(payload);
  if ('error' in found) return found.error;
  const el = found.element;
  const visible = el instanceof HTMLElement ? el.getBoundingClientRect().width > 0 : true;
  return visible ? { ok: true } : { ok: false, error: 'element found but not visible' };
}

export async function executeStep(payload: ReplayActionPayload): Promise<StepResult> {
  switch (payload.verb) {
    case 'click':
      return doClick(payload);
    case 'type':
      return doType(payload);
    case 'select':
      return doSelect(payload);
    case 'submit':
      return doSubmit(payload);
    case 'key_press':
      return doKeyPress(payload);
    case 'scroll':
      return doScroll();
    case 'hover':
      return doHover(payload);
    case 'wait':
      return doWait();
    case 'assert':
      return doAssert(payload);
    case 'navigate':
      return { ok: false, error: 'navigate must be performed by the background, not the content script' };
    default: {
      const never: never = payload.verb;
      return { ok: false, error: `unsupported verb: ${String(never)}` };
    }
  }
}
