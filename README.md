# Pool Dashboard

A single-user, mobile-first web app for managing a home swimming pool. Upload a
Poolwerx water-test PDF and it parses the results into a prioritised action
list, tracks all 8 chemistry metrics against target ranges, reminds you about
recurring maintenance (routines), and keeps a full activity history.

**Live app:** https://reidstephen11.github.io/pool-dashboard/

## Source layout

| File | Purpose |
|---|---|
| `index.html` | Entry point — loads React 18 + Babel standalone from CDN, fonts from Google Fonts, then the two JSX files |
| `app.jsx` | Main app: PDF parser, Dashboard / Chemistry / Log / History screens, state + localStorage persistence |
| `routines.jsx` | Recurring-rule engine, Routines screen, routine editor, and the shared stroke-icon set (`window.Icon`) — must load **before** `app.jsx` |
| `styles.css` | Design tokens and all component CSS |
| `dist/index.standalone.html` | Old fully-inlined offline build (v4, stale — kept for reference until regenerated) |

JSX is transpiled in the browser by Babel standalone, so there is no build
step: any static file server runs the app, e.g.

```
python3 -m http.server 8000
```

## Design system (v4)

Warm paper surfaces, a flat ink hero, one cobalt accent, hairline borders, no
shadows or gradients. Geist for text, Geist Mono for uppercase labels and
numbers (tabular). Icons are a single inline-SVG stroke family (1.5px,
`currentColor`) — no emoji.

```css
--bg: #f6f5f2;      /* page */          --ink: #0c0c0d;   /* text, hero */
--accent: oklch(0.52 0.16 252);         /* cobalt — the only accent */
--bad: oklch(0.55 0.19 25);  --warn: oklch(0.62 0.14 70);  --ok: oklch(0.50 0.12 155);
--hairline: #e8e6df;                    /* 1px borders everywhere */
```

The full token set lives in the `:root` block of `styles.css`. Keep new UI on
these tokens — no new hex colors, no drop shadows, no emoji.

## Data & persistence

All state persists to `localStorage` under the key `poolDashboard_v2`
(`todos`, `testData`, `logEntries`, `phHistory`, `routines`). History →
Export/Import moves data between browsers or devices as a JSON backup file.
Log entries carry a `kind` (`chemical | backwash | aiper | note`); legacy
entries with emoji `icon` fields still render and match routines.

## PDF parsing

Client-side via PDF.js (loaded on demand from cdnjs). The parser is tuned to
the current Poolwerx report format: metric values appear before their labels,
recommendations are extracted from "Add X of Y" lines. See
`parsePoolwerxPDF()` in `app.jsx`.
