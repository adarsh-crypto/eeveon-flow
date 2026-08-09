/**
 * Shapes produced by the content script. Deliberately dumb: one object per browser event,
 * no interpretation. The normaliser is the only consumer.
 */
import type { Selector } from './flow';

export type RawEventType =
  | 'click'
  | 'input'
  | 'change'
  | 'submit'
  | 'keydown'
  | 'scroll'
  | 'navigate'
  | 'pageload';

export interface RawTarget {
  tag: string;
  role: string | null;
  name: string | null;
  selectors: Selector[];
  /** Set when the element is a credential-ish field. The value is dropped at capture. */
  secret: boolean;
  /** Element identity within the page, used to fold consecutive events on the same node. */
  node_key: string;
  input_type: string | null;
}

export interface RawEvent {
  type: RawEventType;
  /** Epoch ms. */
  at: number;
  url: string;
  title: string;
  target: RawTarget | null;
  /** Present for input/change/keydown. Never present when target.secret is true. */
  text?: string;
  /** Present for keydown. */
  key?: string;
  /** Present for scroll: vertical position in px, not a coordinate selector. */
  scroll_y?: number;
}

export interface RecordingSession {
  session_id: string;
  tab_id: number;
  started_at: number;
  origin_url: string;
  origin_host: string;
  origin_title: string;
  events: RawEvent[];
}
