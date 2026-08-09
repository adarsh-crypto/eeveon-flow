/**
 * Collapse canonical events into semantic steps.
 *
 * A human typing "half-life" into a search box produces nine `type` events, a keypress, and
 * a navigation. A workflow has one step: "type half-life into Search". Every rule here folds
 * events that a person would describe as one action, and only those.
 *
 * Invariant: the sum of `raw_count` across the output equals the sum across the input. A rule
 * that drops an event without crediting it to a survivor is a bug, and collapse.test.ts
 * asserts the invariant on every fixture.
 */
import type { CanonicalEvent } from './canonical';

/** Two events further apart than this are separate actions even if otherwise foldable. */
const SAME_ACTION_WINDOW_MS = 5_000;

/** Scrolls closer together than this are one continuous scroll. */
const SCROLL_WINDOW_MS = 2_000;

/**
 * A navigation that lands within this window after a click is that click's consequence,
 * not a step the runner should perform itself.
 */
const NAVIGATION_CONSEQUENCE_MS = 3_000;

function sameNode(a: CanonicalEvent, b: CanonicalEvent): boolean {
  if (!a.target || !b.target) return false;
  return a.target.node_key === b.target.node_key;
}

function isSubmitControl(event: CanonicalEvent): boolean {
  const target = event.target;
  if (!target) return false;
  const type = (target.input_type ?? '').toLowerCase();
  if (type === 'submit') return true;
  const name = (target.name ?? '').toLowerCase();
  return target.role === 'button' && /\b(submit|search|log ?in|sign ?in|save|continue|next)\b/.test(name);
}

export function collapse(events: CanonicalEvent[]): CanonicalEvent[] {
  const out: CanonicalEvent[] = [];

  for (const event of events) {
    const previous = out[out.length - 1];

    if (previous) {
      const gap = event.at - previous.at;

      // 1. Consecutive typing into the same field → one `type` holding the final value.
      //    The last event wins because an input's value is cumulative, not incremental.
      if (
        event.verb === 'type' &&
        previous.verb === 'type' &&
        sameNode(previous, event) &&
        gap <= SAME_ACTION_WINDOW_MS
      ) {
        previous.text = event.text;
        previous.at = event.at;
        previous.raw_count += event.raw_count;
        previous.secret = previous.secret || event.secret;
        continue;
      }

      // 2. Continuous scrolling → one scroll. Only the final resting position matters.
      if (event.verb === 'scroll' && previous.verb === 'scroll' && gap <= SCROLL_WINDOW_MS) {
        previous.at = event.at;
        previous.raw_count += event.raw_count;
        continue;
      }

      // 3. Enter pressed in a field that was just typed into → a submit of that field.
      //    Recording both would make the runner type, press Enter, and submit twice.
      if (
        event.verb === 'key_press' &&
        event.key === 'Enter' &&
        previous.verb === 'type' &&
        sameNode(previous, event)
      ) {
        out.push({ ...event, verb: 'submit', text: null, raw_count: event.raw_count });
        continue;
      }

      // 4. A real `submit` event right after clicking the submit button is the same action.
      if (event.verb === 'submit' && previous.verb === 'click' && isSubmitControl(previous)) {
        previous.verb = 'submit';
        previous.at = event.at;
        previous.raw_count += event.raw_count;
        continue;
      }

      // 5. Navigation caused by the click that preceded it. The click is the instruction;
      //    the URL is recorded on the click so exporters can assert where it should land.
      if (
        event.verb === 'navigate' &&
        (previous.verb === 'click' || previous.verb === 'submit') &&
        gap <= NAVIGATION_CONSEQUENCE_MS
      ) {
        previous.raw_count += event.raw_count;
        previous.url = event.url;
        previous.title = event.title;
        continue;
      }

      // 6. Repeated identical clicks on the same control within the window (double-click,
      //    impatient user) are one click.
      if (event.verb === 'click' && previous.verb === 'click' && sameNode(previous, event) && gap <= 700) {
        previous.at = event.at;
        previous.raw_count += event.raw_count;
        continue;
      }
    }

    out.push({ ...event });
  }

  return dropTrailingNoise(out);
}

/**
 * A scroll or a bare navigation at the very end of a recording is where the user stopped
 * looking around, not part of the workflow. Their raw_count is credited to the last real
 * step so the invariant holds.
 */
function dropTrailingNoise(events: CanonicalEvent[]): CanonicalEvent[] {
  const out = [...events];
  while (out.length > 1) {
    const last = out[out.length - 1]!;
    if (last.verb !== 'scroll') break;
    out.pop();
    out[out.length - 1]!.raw_count += last.raw_count;
  }
  return out;
}
