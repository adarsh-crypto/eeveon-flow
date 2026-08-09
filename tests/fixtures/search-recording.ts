/**
 * A realistic recording: land on a site, type a query one keystroke at a time, press Enter,
 * scroll, click a result, land on a new page. This is the fixture the pipeline tests run on.
 */
import type { RawEvent, RawTarget, RecordingSession } from '../../src/types/capture';

const T0 = 1_770_000_000_000;

function target(overrides: Partial<RawTarget> & { node_key: string }): RawTarget {
  return {
    tag: 'input',
    role: 'searchbox',
    name: 'Search',
    selectors: [{ strategy: 'testid', value: 'search-box', score: 100 }],
    secret: false,
    input_type: 'search',
    ...overrides,
  };
}

export const searchBox = target({ node_key: 'testid:search-box' });

export const resultLink: RawTarget = {
  tag: 'a',
  role: 'link',
  name: 'Half-Life 2',
  selectors: [
    { strategy: 'role', value: 'link[name="Half-Life 2"]', score: 90 },
    { strategy: 'text', value: 'Half-Life 2', score: 70 },
  ],
  secret: false,
  input_type: null,
  node_key: 'role:link[name="Half-Life 2"]',
};

export const passwordBox: RawTarget = {
  tag: 'input',
  role: 'textbox',
  name: 'Password',
  selectors: [{ strategy: 'label', value: 'Password', score: 80 }],
  secret: true,
  input_type: 'password',
  node_key: 'label:Password',
};

export const deleteButton: RawTarget = {
  tag: 'button',
  role: 'button',
  name: 'Delete account',
  selectors: [{ strategy: 'role', value: 'button[name="Delete account"]', score: 90 }],
  secret: false,
  input_type: null,
  node_key: 'role:button[name="Delete account"]',
};

/** "half-life" typed one character at a time, as the browser actually reports it. */
function typingEvents(): RawEvent[] {
  const word = 'half-life';
  return [...word].map((_, i) => ({
    type: 'input' as const,
    at: T0 + 2_000 + i * 120,
    url: 'https://steamcharts.com/',
    title: 'Steam Charts',
    target: searchBox,
    text: word.slice(0, i + 1),
  }));
}

export const searchEvents: RawEvent[] = [
  { type: 'pageload', at: T0, url: 'https://steamcharts.com/', title: 'Steam Charts', target: null },
  { type: 'click', at: T0 + 1_500, url: 'https://steamcharts.com/', title: 'Steam Charts', target: searchBox },
  ...typingEvents(),
  {
    type: 'keydown',
    at: T0 + 3_400,
    url: 'https://steamcharts.com/',
    title: 'Steam Charts',
    target: searchBox,
    key: 'Enter',
  },
  {
    type: 'navigate',
    at: T0 + 4_000,
    url: 'https://steamcharts.com/search?q=half-life',
    title: 'Search results',
    target: null,
  },
  {
    type: 'scroll',
    at: T0 + 5_000,
    url: 'https://steamcharts.com/search?q=half-life',
    title: 'Search results',
    target: null,
    scroll_y: 300,
  },
  {
    type: 'scroll',
    at: T0 + 5_400,
    url: 'https://steamcharts.com/search?q=half-life',
    title: 'Search results',
    target: null,
    scroll_y: 700,
  },
  {
    type: 'click',
    at: T0 + 6_000,
    url: 'https://steamcharts.com/search?q=half-life',
    title: 'Search results',
    target: resultLink,
  },
  {
    type: 'navigate',
    at: T0 + 6_600,
    url: 'https://steamcharts.com/app/220',
    title: 'Half-Life 2 — Steam Charts',
    target: null,
  },
];

export function searchSession(): RecordingSession {
  return {
    session_id: 'test-session',
    tab_id: 1,
    started_at: T0,
    origin_url: 'https://steamcharts.com/',
    origin_host: 'steamcharts.com',
    origin_title: 'Steam Charts',
    events: searchEvents,
  };
}

export const TEST_T0 = T0;
