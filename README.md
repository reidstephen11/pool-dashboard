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
| `sw.js` | Service worker — background routine checks (Periodic Background Sync) + notification clicks. No fetch handler |
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
Log entries carry a `kind` (`chemical | backwash | aiper | note`); legacy
entries with emoji `icon` fields still render and match routines.

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

## PDF parsing

Client-side via PDF.js (loaded on demand from cdnjs). The parser is tuned to
the current Poolwerx report format: metric values appear before their labels,
recommendations are extracted from "Add X of Y" lines. See
`parsePoolwerxPDF()` in `app.jsx`.
