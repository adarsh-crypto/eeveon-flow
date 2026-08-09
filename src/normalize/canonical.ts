/**
 * Raw browser events → canonical events.
 *
 * This stage is a straight translation: one verb per event, noise dropped, no grouping.
 * Grouping is collapse.ts. Keeping them apart means a bad collapse rule can never lose an
 * event that the recorder actually saw.
 */
import type { RawEvent, RawTarget } from '../types/capture';
import type { FlowVerb } from '../types/flow';

export interface CanonicalEvent {
  verb: FlowVerb;
  at: number;
  url: string;
  title: string;
  target: RawTarget | null;
  text: string | null;
  key: string | null;
  secret: boolean;
  /** How many raw events this represents. Always 1 out of this stage. */
  raw_count: number;
}

/** Elements that receive typed text rather than a click. */
const TEXTUAL_INPUT_TYPES = new Set([
  'text',
  'email',
  'search',
  'tel',
  'url',
  'number',
  'password',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

/** Clicks on these are page-background noise, not workflow steps. */
const NOISE_TAGS = new Set(['html', 'body', 'main', 'section', 'div', 'span']);

function isMeaningfulClickTarget(target: RawTarget | null): boolean {
  if (!target) return false;
  if (target.selectors.length === 0) return false;
  // A named, roled, or test-id'd element is intentional regardless of tag.
  if (target.selectors[0]!.strategy !== 'css') return true;
  return !NOISE_TAGS.has(target.tag);
}

function isCheckboxLike(target: RawTarget | null): boolean {
  if (!target) return false;
  const type = (target.input_type ?? '').toLowerCase();
  return type === 'checkbox' || type === 'radio';
}

function isTextualInput(target: RawTarget | null): boolean {
  if (!target) return false;
  if (target.tag === 'textarea') return true;
  if (target.tag !== 'input') return false;
  const type = (target.input_type ?? 'text').toLowerCase();
  return TEXTUAL_INPUT_TYPES.has(type);
}

function make(event: RawEvent, verb: FlowVerb): CanonicalEvent {
  return {
    verb,
    at: event.at,
    url: event.url,
    title: event.title,
    target: event.target,
    text: event.text ?? null,
    key: event.key ?? null,
    secret: event.target?.secret ?? false,
    raw_count: 1,
  };
}

/**
 * @param events raw events in capture order
 * @returns canonical events in the same order, noise removed
 */
export function toCanonical(events: RawEvent[]): CanonicalEvent[] {
  const out: CanonicalEvent[] = [];
  let lastUrl: string | null = null;

  for (const event of events) {
    switch (event.type) {
      case 'pageload':
      case 'navigate': {
        // A reload or a same-URL SPA notification is not a navigation step.
        if (event.url === lastUrl) break;
        lastUrl = event.url;
        out.push(make(event, 'navigate'));
        break;
      }

      case 'click': {
        if (!isMeaningfulClickTarget(event.target)) break;
        // Clicking a checkbox or radio sets a value; that is a selection, not a click.
        out.push(make(event, isCheckboxLike(event.target) ? 'select' : 'click'));
        break;
      }

      case 'input': {
        if (!event.target) break;
        if (!isTextualInput(event.target)) break;
        out.push(make(event, 'type'));
        break;
      }

      case 'change': {
        if (!event.target) break;
        // `change` on a text field duplicates the `input` stream; only non-textual
        // controls (select, checkbox, radio, file) contribute a distinct step.
        if (isTextualInput(event.target)) break;
        out.push(make(event, 'select'));
        break;
      }

      case 'submit': {
        out.push(make(event, 'submit'));
        break;
      }

      case 'keydown': {
        if (!event.key) break;
        out.push(make(event, 'key_press'));
        break;
      }

      case 'scroll': {
        out.push(make(event, 'scroll'));
        break;
      }

      default: {
        // Exhaustiveness guard — a new RawEventType must be handled explicitly.
        const never: never = event.type;
        void never;
      }
    }
  }

  return out;
}
