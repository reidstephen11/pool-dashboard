# Pool Dashboard

A single-user, mobile-first web app for managing a home swimming pool. Upload a
Poolwerx water-test PDF and it parses the results into a prioritised action
list, tracks all 8 chemistry metrics against target ranges, reminds you about
recurring maintenance (routines), and keeps a full activity history.

**Live app:** https://reidstephen11.github.io/pool-dashboard/

## Source layout

| File | Purpose |
|---|---|
| `index.html` | Entry point — loads React 18 + Babel standalone from CDN, fonts from Google Fonts, the notify scripts, then the two JSX files |
| `app.jsx` | Main app: PDF parser, Dashboard / Chemistry / Log / History screens, state + localStorage persistence |
| `routines.jsx` | Recurring-rule engine, Routines screen, routine editor, and the shared stroke-icon set (`window.Icon`) — must load **before** `app.jsx` |
| `styles.css` | Design tokens and all component CSS |
| `notify-core.js` | Reminder logic shared by the page and the service worker: IndexedDB store, "what's due" diff, `showNotification`. Plain JS (runs in both contexts) |
| `notify.js` | Page-side glue — `window.PoolNotify` (permission, SW + periodic-sync registration, schedule mirroring). Loads after `notify-core.js` |
| `sw.js` | Service worker — offline cache (see below) + background routine checks (Periodic Background Sync) + notification clicks |
| `manifest.webmanifest` · `icons/` | PWA manifest and app/notification icons (makes the app installable) |
| `dist/index.standalone.html` | Old fully-inlined offline build (v4, stale — kept for reference until regenerated) |

JSX is transpiled in the browser by Babel standalone, so there is no build
step: any static file server runs the app, e.g.

```
python3 -m http.server 8000
```

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
(`todos`, `testData`, `logEntries`, `phHistory`, `routines`). History →
Export/Import moves data between browsers or devices as a JSON backup file.
Log entries carry a `kind` (`chemical | backwash | aiper | watertest | note`).
`aiper` is the pool-cleaner kind — the UI says "Pool cleaner" everywhere, but
the stored token is kept so existing data keeps matching. Legacy entries with
emoji `icon` fields still render and match routines. Uploading a test PDF also
logs a `watertest` entry (from the report's own date), which resets the
seeded "Get water tested" routine — its frequency is editable like any other
routine's.

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
they're an immediate response to an upload you just performed.

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

- **Same-origin app files are network-first.** A deploy lands on the next load
  exactly as it did before the service worker existed; the cache is only a
  fallback for when the network fails. This matters in a buildless app, where a
  stale `app.jsx` served against a fresh `index.html` would be a real hazard.
- **CDN bundles and Google Fonts are cache-first.** Every one of those URLs
  carries an immutable version (`react@18.3.1`, `pdf.js/3.11.174`, …) so a cached
  copy cannot be wrong, and this is where nearly all the load time goes.

Anything else is not intercepted. Bump `CACHE` in `sw.js` when the precache list
changes.

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
