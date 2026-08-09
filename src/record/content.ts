/**
 * Content script — the only code that touches the page.
 *
 * It captures events, strips secrets before they leave the page, batches, and posts to the
 * service worker. It makes no decisions about what a workflow means; that is the normaliser's
 * job. Listeners are capture-phase so a page calling stopPropagation cannot blind the recorder.
 */
import type { RawEvent, RawTarget } from '../types/capture';
import { accessibleName, buildSelectors, elementRole, nodeKey } from './selectors';
import { isSecretElement, looksLikeSecretValue } from './privacy';
import { executeStep } from '../replay/execute-step';
import type { Message, Response } from '../shared/messages';

const FLUSH_INTERVAL_MS = 400;
const MAX_TEXT_LENGTH = 500;

let recording = false;
let queue: RawEvent[] = [];
let flushTimer: number | null = null;

function describeTarget(el: Element): RawTarget {
  const name = accessibleName(el);
  return {
    tag: el.tagName.toLowerCase(),
    role: elementRole(el),
    name,
    selectors: buildSelectors(el),
    secret: isSecretElement(el, name),
    node_key: nodeKey(el),
    input_type: el.getAttribute('type'),
  };
}

function elementFrom(event: Event): Element | null {
  // composedPath sees through open shadow roots; event.target reports the host.
  const path = event.composedPath?.() ?? [];
  for (const node of path) {
    if (node instanceof Element) return node;
  }
  return event.target instanceof Element ? event.target : null;
}

function base(type: RawEvent['type'], target: Element | null): RawEvent {
  return {
    type,
    at: Date.now(),
    url: location.href,
    title: document.title,
    target: target ? describeTarget(target) : null,
  };
}

function enqueue(event: RawEvent): void {
  if (!recording) return;
  queue.push(event);
  if (flushTimer === null) {
    flushTimer = window.setTimeout(flush, FLUSH_INTERVAL_MS);
  }
}

function flush(): void {
  flushTimer = null;
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  const message: Message = { kind: 'events', events: batch };
  // The worker may be asleep or the tab closing; a dropped batch must not throw into the page.
  void chrome.runtime.sendMessage(message).catch(() => undefined);
}

/** Read a value, unless the field is sensitive. Secret values are never read at all. */
function safeValue(el: Element, target: RawTarget): string | undefined {
  if (target.secret) return undefined;
  const value = (el as HTMLInputElement).value;
  if (typeof value !== 'string') return undefined;
  if (looksLikeSecretValue(value)) {
    target.secret = true;
    return undefined;
  }
  return value.slice(0, MAX_TEXT_LENGTH);
}

function onClick(event: Event): void {
  const el = elementFrom(event);
  if (!el) return;
  enqueue(base('click', el));
}

function onInput(event: Event): void {
  const el = elementFrom(event);
  if (!el) return;
  const evt = base('input', el);
  if (evt.target) {
    const text = safeValue(el, evt.target);
    if (text !== undefined) evt.text = text;
  }
  enqueue(evt);
}

function onChange(event: Event): void {
  const el = elementFrom(event);
  if (!el) return;
  const evt = base('change', el);
  if (evt.target) {
    const text = safeValue(el, evt.target);
    if (text !== undefined) evt.text = text;
  }
  enqueue(evt);
}

function onSubmit(event: Event): void {
  const el = elementFrom(event);
  enqueue(base('submit', el));
}

function onKeyDown(event: KeyboardEvent): void {
  // Only keys that carry intent. Ordinary typing is reconstructed from `input` events, so
  // capturing every keystroke would leak a password one character at a time.
  if (!['Enter', 'Escape', 'Tab'].includes(event.key) && !(event.metaKey || event.ctrlKey)) return;
  const el = elementFrom(event);
  const evt = base('keydown', el);
  evt.key = [event.ctrlKey && 'Ctrl', event.metaKey && 'Meta', event.shiftKey && 'Shift', event.altKey && 'Alt', event.key]
    .filter(Boolean)
    .join('+');
  enqueue(evt);
}

let scrollTimer: number | null = null;
function onScroll(): void {
  if (scrollTimer !== null) return;
  scrollTimer = window.setTimeout(() => {
    scrollTimer = null;
    const evt = base('scroll', null);
    evt.scroll_y = Math.round(window.scrollY);
    enqueue(evt);
  }, 250);
}

const listeners: Array<[string, EventListener, boolean]> = [
  ['click', onClick as EventListener, true],
  ['input', onInput as EventListener, true],
  ['change', onChange as EventListener, true],
  ['submit', onSubmit as EventListener, true],
  ['keydown', onKeyDown as EventListener, true],
  ['scroll', onScroll as EventListener, true],
];

function attach(): void {
  for (const [type, handler, capture] of listeners) {
    document.addEventListener(type, handler, capture);
  }
  window.addEventListener('pagehide', flush);
}

function detach(): void {
  for (const [type, handler, capture] of listeners) {
    document.removeEventListener(type, handler, capture);
  }
  window.removeEventListener('pagehide', flush);
  flush();
}

function setRecording(next: boolean): void {
  if (next === recording) return;
  recording = next;
  if (next) {
    attach();
    enqueue(base('pageload', null));
  } else {
    detach();
  }
}

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.kind === 'start') {
    setRecording(true);
    sendResponse({ ok: true } satisfies Response);
    return false;
  }
  if (message.kind === 'stop') {
    setRecording(false);
    sendResponse({ ok: true } satisfies Response);
    return false;
  }
  if (message.kind === 'run-step') {
    void executeStep(message.payload).then(sendResponse);
    return true; // executeStep is async; keep the message channel open for it
  }
  return false;
});

// A navigation inside a recorded session loads a fresh copy of this script, so ask the
// worker whether recording is already in progress rather than assuming a clean start.
void chrome.runtime
  .sendMessage({ kind: 'is-recording' } satisfies Message)
  .then((response: Response | undefined) => {
    if (response && response.ok && 'recording' in response && response.recording) {
      setRecording(true);
    }
  })
  .catch(() => undefined);
