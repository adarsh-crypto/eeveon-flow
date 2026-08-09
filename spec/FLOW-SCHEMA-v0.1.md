# EEVEON Flow Schema v0.1.0

Flow JSON is the portable artifact EEVEON Flow produces. It is the **only** integration
surface: the recorder writes it, exporters read it, and any future runner (replay engine,
agent, CI job) consumes it. Nothing in the pipeline calls anything else directly.

## Design principles

1. **Semantic, never mechanical.** A step records *what the user did* and against *which
   named element*. Pixel coordinates are never captured and never stored.
2. **Privacy at capture time.** Secret-looking fields are excluded while recording. There is
   no post-hoc redaction pass, because a value that was never captured cannot leak.
3. **Runner-neutral.** The schema contains no Claude-specific, Playwright-specific, or
   browser-specific constructs. Exporters project Flow JSON into those formats.
4. **Parameterised by default.** Every typed value is surfaced as a variable, so a recording
   of "search for X" replays as "search for anything".
5. **Semver.** `format_version` is MAJOR.MINOR.PATCH. Consumers declare the MAJOR they support.

## Document

```jsonc
{
  "format_version": "0.1.0",
  "flow_id": "uuid",
  "name": "Search SteamCharts for a game",
  "description": "optional prose",
  "created_at": "2026-08-08T12:00:00.000Z",
  "origin": { "url": "https://…", "host": "steamcharts.com", "title": "…" },
  "variables": [ /* FlowVariable */ ],
  "steps":     [ /* FlowStep */ ],
  "checkpoints": [ /* Checkpoint */ ],
  "provenance": {
    "recorder": "eeveon-flow",
    "recorder_version": "0.1.0",
    "raw_event_count": 214,
    "step_count": 9,
    "collapsed": true
  }
}
```

### FlowVariable

Typed input surfaced for the runner to fill.

| Field | Type | Notes |
|---|---|---|
| `name` | `string` | snake_case, unique |
| `label` | `string` | human prompt |
| `kind` | `"text" \| "secret"` | `secret` values are never present in the file |
| `default` | `string \| null` | absent for secrets |
| `required` | `boolean` | secrets are always required |
| `used_by` | `string[]` | step ids referencing it |

### FlowStep

| Field | Type | Notes |
|---|---|---|
| `step_id` | `string` | stable within a flow |
| `index` | `number` | 0-based execution order |
| `verb` | see below | controlled vocabulary |
| `intent` | `string` | one plain-language sentence |
| `target` | `Target \| null` | null for `navigate` / `wait` |
| `value` | `Value \| null` | for `type` / `select` / `key_press` |
| `url` | `string \| null` | for `navigate` and post-navigation asserts |
| `risk` | `"low" \| "medium" \| "high"` | drives checkpoints |
| `timing` | `{ offset_ms, dwell_ms }` | relative to recording start |
| `collapsed_from` | `number` | raw events folded into this step (>= 1) |
| `notes` | `string[]` | recorder observations, never instructions |

#### Verbs

`navigate` · `click` · `type` · `select` · `submit` · `key_press` · `scroll` · `hover` ·
`wait` · `assert`

Raw browser event types are normalised into this list. The original type is kept in
`notes` when it is not recoverable from the verb alone.

### Target

```jsonc
{
  "tag": "input",
  "role": "textbox",       // ARIA role, computed or explicit
  "name": "Search",        // accessible name
  "selectors": [ { "strategy": "testid", "value": "search-box", "score": 100 } ],
  "frame": null            // reserved; MVP records the top frame only
}
```

`selectors` is ordered best-first. Strategy priority and score:

| Priority | Strategy | Score | Why |
|---|---|---|---|
| 1 | `testid` | 100 | developer-maintained, survives redesigns |
| 2 | `role` | 90 | accessibility contract (`role` + accessible name) |
| 3 | `label` | 80 | form label association |
| 4 | `text` | 70 | visible text, human-readable |
| 5 | `name` | 50 | `name=` attribute |
| 6 | `id` | 45 | ids are often generated |
| 7 | `css` | 30 | structural, brittle |

There is no `xpath` strategy and no coordinate strategy. A target with zero selectors is a
validation error — the step is unrunnable and must be dropped or repaired.

### Value

```jsonc
{ "kind": "literal", "text": "half-life" }
{ "kind": "variable", "variable": "search_term" }
{ "kind": "secret",   "variable": "password" }   // no text field, ever
```

### Checkpoint

Human-in-the-loop pause emitted for any `medium` or `high` risk step.

```jsonc
{ "checkpoint_id": "cp_3", "before_step": "s_7", "reason": "submits a form", "severity": "medium" }
```

## Risk model

Risk is computed at compile time from signals, not authored by hand.

| Signal | Result |
|---|---|
| target is a password / credential field | `high` (and value is `secret`) |
| step submits a form | `medium` |
| click whose accessible name matches destructive intent (`delete`, `remove`, `pay`, `buy`, `confirm`, `transfer`, `deploy`) | `high` |
| navigation to a different host than `origin.host` | `medium` |
| everything else | `low` |

## Validation rules

A Flow is valid when all of these hold. Rule ids are stable — exporters and tests cite them.

| Rule | Statement |
|---|---|
| `F1_FORMAT_VERSION` | `format_version` is a semver string with MAJOR `0` or `1` |
| `F2_STEPS_PRESENT` | at least one step |
| `F3_INDEX_CONTIGUOUS` | `index` values are 0..n-1 with no gaps, matching array order |
| `F4_TARGET_RESOLVABLE` | every step whose verb needs a target has >= 1 selector |
| `F5_NO_COORDINATES` | no selector value matches a coordinate pattern |
| `F6_NO_SECRET_LITERALS` | no `value.kind === "secret"` carries `text` |
| `F7_VARIABLES_DECLARED` | every `value.variable` referenced exists in `variables` |
| `F8_URL_ON_NAVIGATE` | every `navigate` step has an absolute `url` |
| `F9_CHECKPOINT_TARGETS` | every checkpoint's `before_step` exists |
| `F10_RISK_COVERAGE` | every `medium`/`high` step is preceded by a checkpoint |
| `F11_SIZE` | document serialises under 2 MB |

Validation returns every violation, not the first one.

## Exports

| Format | Consumer | Fidelity |
|---|---|---|
| Flow JSON | anything | source of truth |
| `SKILL.md` | Claude Code / agent runtimes | lossy: timing dropped, prose added |
| Playwright `.spec.ts` | CI, headless replay | lossy: intent becomes comments |

Exports are one-way projections. Flow JSON is never reconstructed from an export.

## Amendment log

| Version | Date | Change |
|---|---|---|
| 0.1.0 | 2026-08-08 | Initial schema. |
