# Pool Dashboard — technical notes

How the app is built and how its parts fit together. For what the app does and
how to set up your own copy, see the [README](../README.md).

## Source layout

| File | Purpose |
|---|---|
| `index.html` | Entry point — loads React 18 + Babel standalone from CDN, fonts from Google Fonts, the notify scripts, then the two JSX files. Shows "Loading…" until the app renders, and a Reload prompt if it never does |
| `app.jsx` | Main app: PDF parser, Dashboard / Chemistry / Log / History screens, equipment settings and Copy for agent, state + localStorage persistence |
| `routines.jsx` | Recurring-rule engine, Routines screen, routine editor, and the shared stroke-icon set (`window.Icon`) — must load **before** `app.jsx` |
| `styles.css` | Design tokens and all component CSS |
| `notify-core.js` | Reminder logic shared by the page and the service worker: IndexedDB store, "what's due" diff, `showNotification`. Plain JS (runs in both contexts) |
| `notify.js` | Page-side glue — `window.PoolNotify` (permission, SW + periodic-sync registration, schedule mirroring). Loads after `notify-core.js` |
| `sync-report.js` | Remote water-test slot: fetch URL, JSON schema check, and the map onto the PDF parser's result shape. Plain JS (page and service worker) |
| `sw.js` | Service worker — offline cache (see below) + background routine checks (Periodic Background Sync) + notification clicks |
| `manifest.webmanifest` · `icons/` | PWA manifest and app/notification icons (makes the app installable) |
| `docs/` | This file and the README screenshots (not deployed) |
| `build.js` | Writes `_site/`, the deployed copy: JSX compiled ahead of time into one `app.js`, `index.html` without Babel, `sw.js` precaching the built files (see **Build and deploy**) |
| `sync-report.test.js` · `app.test.js` | Tests (`npm test`): the sync format and the published sync file; routine dates, log order, trend history, equipment settings, the agent summary |
| `.github/workflows/pages.yml` | Runs the tests and the build on every push and pull request, and deploys to Pages |

Locally there is still no build step. Babel standalone compiles the JSX in the
browser, so any static file server runs the app, e.g.

```
python3 -m http.server 8000
```

## Build and deploy

Compiling in the browser costs a 3 MB download on first visit and several
seconds on every open on a phone (measured with the CPU slowed 4× and the files
served locally: about 6.7 s to the first screen, against 0.7 s for the
pre-compiled build). So the deployed
site is built: `npm ci && npm run build` writes `_site/` with the JSX compiled
once by `build.js`. The build fails, rather than deploying something broken, if
a file the service worker precaches is missing or the sync file is not included.

`.github/workflows/pages.yml` runs `npm test` and the build on every push and
pull request. On `main` it deploys `_site/` — **once Settings → Pages → Source
is set to "GitHub Actions"**. While Pages still publishes the branch directly,
the workflow only checks, and the site keeps working exactly as before (compiled
in the browser).

The tests do not block a deploy. The email automation publishes each report by
pushing the sync file to `main`, and an unrelated failing test must not stop it
going live. A failing test still marks the run red, and GitHub emails the
person who pushed.

## Design system (v4 · "Deep Lagoon")

Cool chalky off-white surfaces, a deep teal-navy hero, one clean-water cyan
accent, hairline borders, no shadows or gradients. Geist for text, Geist Mono
for uppercase labels and numbers (tabular). Icons are a single inline-SVG
stroke family (1.5px, `currentColor`) — no emoji.

```css
--bg: #eef5f8;       /* cool page */      --ink: #0c1a22;    /* text */
--accent: #087299;                        /* clean-water cyan — the only accent */
--bad: #c62436;  --warn: #a15c00;  --ok: #0f7852;   /* status */
--hairline: #dbe6ea;                      /* 1px borders everywhere */
--hero-bg: #0a2a3a;                        /* deep-water teal-navy hero */
```

The full token set lives in the `:root` block of `styles.css`. Keep new UI on
these tokens — no new hex colors, no drop shadows, no emoji.

## Data & persistence

All state persists to `localStorage` under the key `poolDashboard_v2`
(`todos`, `testData`, `logEntries`, `testHistory`, `routines`,
`equipmentHistory`, and `lastRemoteReportId` once a remote report has been
applied). History →
Export/Import moves data between browsers or devices as a JSON backup file.

`testHistory` holds every reading of each test (one point per test day, oldest
first, up to 24) and feeds the trend charts on Home and Chemistry. It was added
in 2.7; before that only pH was kept, in `phHistory` (labels with no year). On
first load that list is folded into `testHistory`, and a derived `phHistory` is
still saved so an older version of the app keeps working after a rollback.

`logEntries` is kept newest first by `ts`, which routine due dates rely on.
Every write inserts in date order, so a back-dated entry lands in its place, and
lists saved before that are sorted on load. Marking an action or routine done,
and deleting a History entry, can be undone from the toast.

If the app hits an error while drawing the screen, a recovery screen replaces
it with **Export my data**, **Reload** and **Reset app data**. Without it the page
went blank on every open, because the data that caused the error was saved.
Log entries carry a `kind` (`chemical | backwash | aiper | watertest | note`).
`aiper` is the pool-cleaner kind — the UI says "Pool cleaner" everywhere, but
the stored token is kept so existing data keeps matching. Legacy entries with
emoji `icon` fields still render and match routines. Uploading a test PDF also
logs a `watertest` entry (from the report's own date), which resets the
seeded "Get water tested" routine — its frequency is editable like any other
routine's.

## Equipment settings and Copy for agent

The Chemistry screen has an **Equipment** section for the chlorinator output (%)
and the filter pump's start and stop times, with the date they were changed.
Each change is kept in `equipmentHistory` (oldest first, one entry per calendar
day, so saving twice on the same date corrects it):

```json
{ "ts": 1790467200000, "chlorinatorPct": 40, "filterStart": "09:00", "filterEnd": "15:00" }
```

`ts` is local midnight of the change date. Times are 24-hour `HH:MM`; a stop
time earlier than the start runs past midnight (22:00–04:30 is 6 h 30 min).
Saved and imported lists are cleaned on load, and a backup without the field
leaves the current settings alone.

**Copy data for agent** puts a plain-text summary on the clipboard to paste into
an agent chat: the settings history, the last 12 tests (each with the settings
that were running before it), target ranges, open Poolwerx actions, routines,
and the last 90 days of activity. A setting changed on a test's own day is not
counted for that test, because a change made that day usually came after the
results. The text is built by `agentSummary()` in `app.jsx`, which the tests
cover.

## Reminders (push notifications)

Opt-in via the **Reminders** toggle on the Routines screen. When enabled, the app
notifies you the moment a new item lands on your action list:

- **A routine comes due** (e.g. "Add 500 mL acid" every Saturday) — the app mirrors
  each routine's next-due timestamp into IndexedDB, and both the running app and a
  background Periodic Background Sync check it and fire a notification once per
  due-cycle (de-duplicated via a `notified` map so you're not pinged repeatedly).
- **A new test is imported** — a summary notification for the actions the PDF added.

Routines are day-precision, so a routine's due timestamp is local **midnight** — but
the background sync usually runs while the phone sits idle on a charger overnight,
which would deliver the reminder at 3am. Routine reminders are therefore held until a
**"Not before" hour (default 08:00 local)**, set on the Reminders card and stored in
IndexedDB (`notifyHour`) so the service worker sees it too. The gate is on the wall
clock rather than on the item, so an overdue routine can't leak out at night either —
it waits for the first check after that hour. Test-import notifications are not gated:
they fire when a PDF upload or a remote sync applies a test that adds actions.

It's entirely client-side — no backend. On an **installed PWA (Android/Chromium)**
Periodic Background Sync delivers reminders even when the app is closed (the browser
controls cadence — roughly daily, best-effort). Everywhere else, reminders fire while
the app is open and it catches up on focus. The feature is fully feature-detected: if
notifications, service workers or IndexedDB are unavailable/blocked, the toggle hides
itself and the app behaves exactly as before.

Note that the service worker itself is registered on every load, because it also
backs the offline cache — registering it asks the user for nothing. Notification
*permission* is still requested only when the Reminders toggle is switched on.

## Offline

The service worker registers on every load (not just when reminders are enabled)
and precaches the app shell plus the version-pinned CDN bundles, so the app opens
with no connection — which is the normal case standing next to the pool.

Two cache strategies, chosen so that going offline can never mean running stale
code:

- **Same-origin app files are network-first, with a 3 s limit.** A deploy lands
  on the next load as long as the connection answers. The cache answers when the
  network fails, or when it takes longer than 3 s and a cached copy exists. The
  slow response still refreshes the cache for next time. After one slow request,
  the rest of that load (15 s) comes straight from the cache, so a weak signal
  costs about 3 s once rather than per file, and a load doesn't mix fresh and
  cached files. The deployed build is a single `app.js`, which removes the
  remaining case where cached and fresh scripts could meet.
- **CDN bundles and Google Fonts are cache-first.** Every one of those URLs
  carries an immutable version (`react@18.3.1`, `pdf.js/3.11.174`, …) so a cached
  copy cannot be wrong, and this is where nearly all the load time goes.

Anything else is not intercepted. The remote sync JSON is excluded on purpose
so it cannot be served from the cache. Bump `CACHE` in `sw.js` when the precache
list changes. `build.js` rewrites the block between the `@build-start` and
`@build-end` markers for the deployed copy (`CACHE` gains a `-built` suffix), so
keep those markers and keep `CACHE`, `APP_SHELL` and `VENDOR` as plain
literals.

Tabs are in the browser history (`#chemistry`, `#log`, …), so the phone's Back
button returns to Home before it leaves the app, and closes the routine editor
first when it's open.

## PDF parsing

Client-side via PDF.js (loaded on demand from cdnjs, with a 20s timeout so a
stalled CDN can't wedge the upload). The parser is tuned to the current Poolwerx
report format. See `parsePoolwerxPDF()` in `app.jsx`.

The results table reads `CURRENT  PREVIOUS  LABEL  RANGE`, so a metric's value
sits *before* its label and the first of the two numbers is the new reading. Six
consecutive real reports confirm this: each one's PREVIOUS column matches the
value parsed from the report before it, for all 8 metrics.

Recommendations are numbered sections (`1  PH`, `2  TOTAL CHLORINE`), and **one
action is produced per section** — not per dose. Most sections carry an
"Add X of Y" line, but some are plain instructions ("Reduce your chlorinator
hours/level"), and those appear on four of the six real reports, always while
chlorine reads well over target. Scanning for doses dropped every one of them.

Guardrails worth knowing about before changing it:

- Metric values are only read from the text **before** `RECOMMENDATIONS`. That
  block numbers its sections (`1 PH`, `2 COMBINED CHLORINE`), and a
  case-insensitive whole-document search will happily return a section number as
  a metric value.
- Each metric has a **list** of label spellings (`METRIC_LABELS`), most specific
  first, because the results table abbreviates some of them (`Combined Cl`) while
  the recommendations spell them out.
- Numbers are parsed with `parseReportNum`, which handles thousands separators
  (`4,200`) and returns `null` rather than `NaN` for junk.
- There is deliberately **no** "number after the label" fallback. It used to
  match a label as a prefix and return the target range's low bound as the
  reading — a fabricated value that always looked plausible. A metric that can't
  be read is `null`, surfaces as "Not in this report" on the Chemistry screen, and
  is counted in the upload toast ("Loaded 6 of 8 results").
- A section heading is `<number><gap><ALL CAPS>`. The real reports always use a
  2+ space gap, which is what keeps the pattern out of dose text; a single space
  is still accepted, but then a unit blocklist stops "Add 20 ML of …" being read
  as section 20 named "ML".
- The dose line is separated from its explanation by a run of 2+ spaces (it is
  its own line in the PDF), so the dose text stops there rather than at a
  character budget — a budget ran on into the explanation and cut it mid-word.
- A recommendation is attributed to a metric via `PARAM_METRIC`, matching on the
  section heading. Don't go back to substring matching on metric labels: "ph" is
  a substring of "phosphates" (a phosphate dose was captioned "pH is 7.6" and
  demoted to MED), and "total" in "TOTAL CHLORINE" matches the "Total Alk"
  metric. The report also abbreviates alkalinity as "TOT. ALKALINITY (ADJUSTED)".
- An upload that yields no metrics and no recommendations is rejected without
  touching state, and a report older than the current one asks for confirmation
  first.
- The report carries 12 rows; the app tracks 8. Total Chlorine, Total Hardness,
  Total Copper and Temperature are deliberately not modelled — Total Hardness has
  equalled Calcium Hardness on every report so far, and the Total Chlorine advice
  is surfaced through Free Chlorine, which is tracked.

## Remote sync

An external automation can publish a water-test result so the app imports it
the next time it is opened or brought into focus — no import button. The sync
slot is a same-origin path hardcoded in `sync-report.js` (not listed here).
The file is fetched with `cache: 'no-store'` and is not part of the service
worker precache. The long folder name keeps the file from being guessed, but it
is not private: this repository is public, and anyone reading `sync-report.js`
can find it. That's fine for pool readings; don't put anything in the file that
you wouldn't publish.

The file holds the latest published report (it began as a placeholder with
`reportId` and `testedAt` both null, which the app treats as a silent no-op).
`sync-report.test.js` checks whatever is published: it must be the placeholder
or a report the app would accept, and must not contain an email address, a
phone number, or a personal-details field such as `address` or `customer`.
Don't change the path or the format without updating the automation that
writes it.

### What the writer should publish

Replace the placeholder with a single JSON object. Chemistry, the report date,
and recommendations only — do not include the customer name, street address,
email, or phone.

```json
{
  "schema": 1,
  "reportId": "6457546",
  "testedAt": "2026-09-04",
  "source": "poolwerx-email",
  "publishedAt": "2026-09-04T01:23:45.000Z",
  "metrics": {
    "ph": 7.4,
    "freeCl": 3.1,
    "combCl": 0.2,
    "salt": 4200,
    "alk": 100,
    "caHard": 280,
    "cya": 50,
    "phos": 0,
    "lsi": 0.1,
    "pool": 40000
  },
  "recs": [
    { "param": "PH", "action": "Add 200 mL of hydrochloric acid" }
  ]
}
```

- `testedAt` is a calendar date, `YYYY-MM-DD`. The report's own spelling
  (`4 Sep 2026` or `4 September 2026`) is also accepted. It is not converted
  through time zones.
- `pool` is the volume in litres. `source` and `publishedAt` are stored for the
  writer; the app does not display them or use them to decide which report is
  newer.
- `recs` use the same `param` / `action` pair `parsePoolwerxPDF()` returns.
  `param` is the recommendation heading (`PH`, `COMBINED CHLORINE`,
  `CALCIUM HARDNESS`, …). A rec may instead use `metric` (a metric id such as
  `freeCl`, or a heading) and `text` (the action). A `priority` field is
  ignored: HIGH/MED is derived from the metric status, the same way a PDF
  upload does it.
- Metric names match the parser (`freeCl`, `combCl`, `caHard`, …), not the
  ids on the chemistry screen (`fcl`, `ccl`, `cah`).

`sync-report.js` maps that object onto the parser result, and
`planTestImport()` in `app.jsx` is the only function that writes it into
state. The file picker calls the same function.

On load, and again whenever the window is focused or the tab becomes visible,
a report is imported when all of these hold:

- `schema` is `1`, and there is a `reportId` or a `testedAt`, plus at least
  one metric or recommendation.
- That id has not already been applied (`lastRemoteReportId` in
  `poolDashboard_v2`). A file with no `reportId` is keyed by its `testedAt`.
- The test is newer than the one currently loaded. An older report is a silent
  no-op — the manual upload still asks before replacing a newer test. A remote
  report dated the same day as the loaded test is also left alone, so a sync
  cannot wipe actions already on the list for that test.

A network error, HTTP 404, placeholder, bad JSON, or schema mismatch leaves
existing state untouched (a warning is logged for a schema mismatch; the
placeholder stays quiet).

The service worker cannot write `localStorage`. On the existing periodic
background sync — the one Reminders registers — it fetches the same URL and,
when the body is a real report, stashes the parsed chemistry in IndexedDB
(`pendingRemoteReport`). The next time the page opens, that stash is applied
if it is still the newest unapplied report. Opening the app is what actually
imports; the background pass only saves a round trip when the page is closed.
