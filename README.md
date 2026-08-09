# EEVEON Flow

Record a browser workflow. Replay it, or hand it to an agent.

You click through a task once — search a site, fill a form, pull a report. EEVEON Flow
watches, folds the hundreds of raw browser events into the handful of steps a person would
actually describe, and compiles them into **Flow JSON**. From there you can replay it in the
same tab with approval gates on the risky steps, or export it as a `SKILL.md` for an agent
runtime or a Playwright spec for CI.

Everything runs locally. No account, no server, no cloud.

## Status

MVP — recording, compiling, replaying, and exporting all work end to end.

| | |
|---|---|
| Tests | 73 passing |
| Typecheck | clean (`tsc --noEmit`) |
| Build | 3 bundles: sidepanel 267 kB, worker 102 kB, content script 11 kB |

## Install

```bash
npm install
npm run build
```

Then `chrome://extensions` → enable Developer Mode → **Load unpacked** → pick `dist/`.
Click the toolbar icon to open the side panel.

## Use

1. Open the page you want to record.
2. Side panel → **Record this tab**. The badge reads `REC` while it runs.
3. Do the task.
4. **Stop and compile.** The panel shows the compiled steps, the inputs it found, and any
   approval gates.
5. Either **Run this flow** (fill in the inputs it asks for, approve the checkpointed steps
   as they come up) or export it as Flow JSON, `SKILL.md`, or a Playwright spec.

Replay executes against your currently active tab: `navigate` steps go through
`chrome.tabs.update`; every other step is sent to the content script, which resolves the
same selectors the recorder wrote down and performs the action. A step guarded by a
checkpoint pauses the whole run — nothing after it executes until you approve or stop.

## How it works

```
browser events                      content script, capture phase
      │                             secrets excluded here, never captured
      ▼
RawEvent[]                          one object per event, no interpretation
      │
      ▼  toCanonical()
CanonicalEvent[]                    verbs assigned, page noise dropped
      │
      ▼  collapse()
semantic steps                      9 keystrokes → 1 "type", click+navigation → 1 step
      │
      ▼  compileFlow()
Flow JSON                           + variables, risk tiers, approval checkpoints
      │
      ├──▶ replay in the browser    same selectors, tab.update for navigate, checkpoints pause the run
      ├──▶ SKILL.md                 for Claude Code and other agent runtimes
      ├──▶ *.spec.ts                for Playwright / CI
      └──▶ .flow.json               the source of truth
```

Flow JSON is the only integration surface. The recorder writes it; exporters read it.
Nothing calls anything else directly, so a new export target is one file with no changes
elsewhere.

Full format: [`spec/FLOW-SCHEMA-v0.1.md`](spec/FLOW-SCHEMA-v0.1.md).

## The three things it does that a plain recorder does not

**Collapses.** A raw recording of "search for half-life" is 9 input events, a keypress, a
navigation, two scrolls and a click. The compiled flow is 4 steps. `collapse()` holds one
invariant — every raw event is credited to a surviving step — so the fold can never silently
lose an action.

**Excludes secrets at capture time.** Password fields, credential-shaped names, payment
autocomplete tokens and high-entropy pasted values are never read. There is no redaction
pass, because a value that was never captured cannot leak through a downstream exporter
bug. Secrets become required variables the runner supplies at execution time.

**Rates risk and gates it.** Submitting a form is medium. Entering a credential, or clicking
anything named `delete` / `pay` / `deploy`, is high. Every non-low step gets a checkpoint.
The replay engine actually stops there and waits for you; the `SKILL.md` renders it as a
stop-and-ask instruction; the Playwright spec renders it as a flagged comment.

## Replay

The service worker runs one step at a time against the tab you started the recording in
(or, for a saved flow, whichever tab is active when you hit Run):

- `navigate` steps go through `chrome.tabs.update` + wait for `onUpdated` to report complete
- everything else is sent to the content script, which resolves the step's selectors
  ([`src/replay/resolve.ts`](src/replay/resolve.ts)) in the same best-first order they were
  recorded, then performs the action
  ([`src/replay/execute-step.ts`](src/replay/execute-step.ts)) — text inputs go through the
  native value setter so framework-controlled fields (React, etc.) see the change
- a step with a checkpoint pauses the run before it executes; **Approve** resumes exactly
  that one step, **Stop instead** ends the run
- text variables prefill with their recorded value and are editable; secret variables are
  required and typed as a password field. Run-time values live only in
  `chrome.storage.session` (memory, cleared on browser close) — never in the same store as
  a saved Flow JSON, so a secret you type in to run a flow can never end up inside an
  exported artifact

Known limitation: an MV3 service worker can be killed after ~30s idle with no extension-API
call in flight. A very slow page mid-`wait` step could in theory stall a run; a keepalive
alarm would close that gap if it becomes a problem in practice.

## Selectors

Semantic only, ranked best-first:

| Priority | Strategy | Playwright locator |
|---|---|---|
| 1 | `data-testid` | `getByTestId` |
| 2 | role + accessible name | `getByRole` |
| 3 | form label | `getByLabel` |
| 4 | visible text | `getByText` |
| 5 | `name` / `id` | `locator` |
| 6 | short css path | `locator` |

Coordinates are never captured, never stored, and never exported. Validation rule `F5`
fails a flow that contains one.

## Development

```bash
npm run dev        # rebuild on change
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

Layout:

```
src/record/      content script, selector extraction, privacy rules
src/normalize/   raw → canonical events, then collapse into steps
src/compile/     Flow JSON compiler, risk model, validator (F1..F11)
src/replay/      selector resolution + step execution (content-side), orchestrator (worker-side)
src/export/      SKILL.md, Playwright, JSON
src/background/  MV3 service worker, chrome.storage persistence, replay orchestration
src/sidepanel/   React UI (record, library, run)
spec/            the schema, versioned
```

## Not in this build

Non-Chrome browsers, iframe recording, a sync backend, and anything cloud. The schema has
room for all of them; none of them are wired. Replay's selector resolution is a heuristic
(role lookup walks every element on the page) — fine for the pages tested against, not yet
hardened against pathological DOM sizes.
