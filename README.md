# gtfs-to-html-enhanced

A fork of [gtfs-to-html](https://github.com/blinktaginc/gtfs-to-html) extended with three analytical modes for transit network planning and redesign:

- **Standard timetables** — the original gtfs-to-html HTML/PDF/CSV output, unchanged
- **Network comparison** — side-by-side HTML diff of an existing vs. a proposed GTFS network, with per-route timetable diffs and stop departure boards
- **Network diagnostics** — automated analysis of a single GTFS feed for hidden trunk frequency, branch dilution, span legibility, and circuity, rendered as an interactive HTML report

All output HTML can be made fully self-contained (single-file, no external dependencies except optional map tiles) with `"selfContained": true`.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | Check with `node --version` |
| pnpm | any recent | Install: `npm install -g pnpm` |
| SQLite | ≥ 3.31 | Bundled via `better-sqlite3` — no separate install needed |

---

## Installation

```bash
git clone https://github.com/enricofedeli/gtfs-to-html-enhanced.git
cd gtfs-to-html-enhanced
pnpm install
pnpm build
```

`pnpm build` compiles TypeScript to `dist/` and copies browser-compatible library bundles (MapLibre GL, pbf, etc.) to `dist/browser/`.

---

## Quick start (timetables)

Create a `config.json`:

```json
{
  "agencies": [
    {
      "agencyKey": "my-agency",
      "path": "/path/to/gtfs.zip"
    }
  ],
  "sqlitePath": "/tmp/my-agency.sqlite",
  "outputPath": "/tmp/my-agency-html"
}
```

Run:

```bash
node dist/bin/gtfs-to-html.js --configPath config.json
```

Open `/tmp/my-agency-html/` in a browser. HTML timetables are created for every route and service day found in the GTFS feed.

On subsequent runs, add `"skipImport": true` to skip re-importing the GTFS database (much faster).

---

## Configuration reference

All options are set in the JSON config file passed via `--configPath`. Every field is optional except `agencies`.

### Core

| Key | Type | Default | Description |
|---|---|---|---|
| `agencies` | array | **required** | List of GTFS feeds to import. Each entry needs `agencyKey` (unique string) and either `path` (local zip/folder) or `url` (remote zip URL). |
| `sqlitePath` | string | `./gtfs.sqlite` | Path for the SQLite database. Reuse across runs with `skipImport: true`. |
| `outputPath` | string | `./html` | Directory where HTML files are written. |
| `skipImport` | boolean | `false` | Skip GTFS import; use the existing DB at `sqlitePath`. |
| `noHead` | boolean | `false` | Emit HTML fragments without `<html>`/`<head>`/`<body>` (for embedding in a CMS). |
| `assetPath` | string | `''` | Prefix prepended to all CSS/JS asset references. Leave empty for same-directory assets. |
| `overwriteExistingFiles` | boolean | `true` | Overwrite existing output files. |
| `verbose` | boolean | `false` | Print detailed import and generation logs. |

### Timetable display

| Key | Type | Default | Description |
|---|---|---|---|
| `outputFormat` | `'html'` \| `'pdf'` \| `'csv'` | `'html'` | Output format. `'pdf'` uses headless Chromium (Puppeteer); `'csv'` exports raw schedule data. |
| `showMap` | boolean | `false` | Embed an interactive MapLibre GL map on each timetable page and the overview. Requires internet access for map tiles. |
| `mapStyleUrl` | string | OSM raster | MapLibre style URL for the basemap (e.g. a Mapbox or MapTiler style). |
| `menuType` | `'none'` \| `'simple'` \| `'jump'` \| `'radio'` | `'simple'` | Navigation menu style when multiple service periods exist. |
| `beautify` | boolean | `false` | Pretty-print generated HTML (adds whitespace). |
| `selfContained` | boolean | `false` | Inline all local CSS and JS directly into each HTML file so it can be opened standalone, with no sibling folders needed. MapLibre (when `showMap: true`) loads from CDN instead of local bundle. |
| `showArrivalOnDifference` | number | `null` | Show arrival time in a cell when it differs from departure by at least this many minutes. |
| `showCalendarExceptions` | boolean | `false` | Show added/removed service dates from `calendar_dates.txt`. |
| `showOnlyTimepoint` | boolean | `false` | Only show stops marked `timepoint=1` in `stop_times.txt`. |
| `showRouteTitle` | boolean | `true` | Show the route name in the timetable page header. |
| `showStopCity` | boolean | `false` | Append stop city from `stops.txt` to stop names. |
| `dateFormat` | string | `'MMM D, YYYY'` | Date format string (dayjs/moment style). |
| `timeFormat` | string | `'h:mm A'` | Time format string. |
| `coordinatePrecision` | number | `5` | Decimal places for GeoJSON coordinates in map output. |
| `zipOutput` | boolean | `false` | Zip the output directory after generation. |

### Branding

| Key | Type | Default | Description |
|---|---|---|---|
| `brandingLogo` | string | — | URL or relative path to a logo image shown in headers (diagnostics and comparison pages). |
| `brandingTitle` | string | agency name | Custom title string used in page headings. |
| `brandingAccentColor` | string | `#0057b8` | CSS colour for header borders and accents. |

### Time periods

For comparison and diagnostics modes, define custom time bands. If omitted, defaults to Early / AM Peak / Midday / PM Peak / Evening.

```json
"timePeriods": [
  { "label": "Morning",   "start": "06:00", "end": "09:00" },
  { "label": "Midday",    "start": "09:00", "end": "16:00" },
  { "label": "Afternoon", "start": "16:00", "end": "20:00" }
]
```

| Key | Type | Description |
|---|---|---|
| `timePeriods` | `TimePeriod[]` | Array of `{ label, start, end }`. Times are `"HH:MM"` 24-hour. Periods should be contiguous and non-overlapping. |

### Network comparison mode

| Key | Type | Default | Description |
|---|---|---|---|
| `comparisonMode` | boolean | `false` | Enable comparison pipeline. |
| `comparisonAgency` | object | — | The **proposed** network. Same shape as an `agencies` entry plus optional `sqlitePath`. |
| `stopMatchingDistanceMeters` | number | `150` | Maximum distance in metres to consider two stops (existing vs. proposed) as the same physical stop. |
| `routeOverlapThreshold` | number | `0.5` | Minimum fraction of stop overlap required to match a proposed route to an existing one (0–1). |
| `generateStopPages` | boolean | `false` | Generate per-stop departure board comparison pages (one HTML file per matched stop). |
| `timePeriods` | `TimePeriod[]` | defaults | Time bands used for headway comparison tables. |

### Network diagnostics

| Key | Type | Default | Description |
|---|---|---|---|
| `runDiagnostics` | boolean | `false` | Run diagnostics after timetable generation (when using the main CLI). |
| `diagnosticsSampleDate` | string | **required** | ISO date `"YYYY-MM-DD"` — the representative weekday to analyse. Must fall within the feed's `calendar.start_date` / `calendar.end_date` range. |
| `diagnosticsOutputPath` | string | `outputPath/diagnostics` | Directory for diagnostics output (CSV, JSON, `index.html`). |
| `diagnosticsZone` | object | whole network | Restrict analysis to a zone: `{ "routeIds": ["11","87"], "stopIds": [...], "boundingBox": [minLon, minLat, maxLon, maxLat] }` |
| `diagnosticsHiddenTrunkMinTripsPerHour` | number | `6` | Combined tph threshold above which a stop-pair segment is flagged as a hidden trunk (6 tph = every 10 min). |
| `diagnosticsBranchDilutionRatioThreshold` | number | `1.5` | Trunk-to-branch frequency ratio above which a route is flagged for dilution. |
| `diagnosticsBranchDilutionMinTrunkTph` | number | `1.0` | Minimum trunk tph required before a route can be flagged for dilution (avoids flagging very infrequent routes). |
| `diagnosticsCircuityFlagThreshold` | number | `2.0` | Path-length / straight-line ratio above which a route is flagged as circuitous. |
| `diagnosticsCircuityMinStraightLineKm` | number | `0.2` | Routes whose first-to-last stop distance is below this are treated as circular loops and excluded from circuity analysis. |
| `diagnosticsRailFeedSqlitePath` | string | — | Path to a separately imported rail GTFS SQLite database. Enables the rail–bus connection matrix diagnostic (Diagnostic 3). |
| `diagnosticsMaxTransferWaitMinutes` | number | `20` | Maximum acceptable wait for a bus connection after a train arrival. Connections exceeding this are flagged. |

---

## Output mode: Standard timetables

The default mode. Run with:

```bash
node dist/bin/gtfs-to-html.js --configPath config.json
```

**What is generated:**

- `outputPath/` — one HTML file per timetable page (grouped by route and service period)
- `outputPath/index.html` — overview page listing all routes
- `outputPath/css/`, `outputPath/js/` — shared stylesheets and scripts
- Optionally: route maps, PDF files, or a zip archive

**Typical config:**

```json
{
  "agencies": [
    { "agencyKey": "myagency", "path": "/data/gtfs.zip" }
  ],
  "sqlitePath": "/tmp/myagency.sqlite",
  "outputPath": "/var/www/timetables",
  "showMap": true,
  "selfContained": false
}
```

---

## Output mode: Network comparison

Compares two GTFS feeds (existing vs. proposed network) and produces side-by-side HTML reports showing what changed for each route and stop.

**How it works:**

1. Import both GTFS feeds into separate SQLite databases
2. Match stops between networks using distance (configurable) and fuzzy name similarity
3. Match routes between networks using stop-sequence overlap (configurable)
4. For each matched route: compute per-time-period headway, show added/removed stops, flag headway changes
5. Generate overview page + per-route comparison timetables + (optionally) per-stop departure boards

**Run with:**

```bash
node dist/bin/gtfs-to-html.js --configPath config-comparison.json
```

**Example config:**

```json
{
  "agencies": [
    {
      "agencyKey": "existing",
      "path": "/data/existing-network.zip"
    }
  ],
  "sqlitePath": "/tmp/existing.sqlite",

  "comparisonMode": true,
  "comparisonAgency": {
    "agencyKey": "proposed",
    "path": "/data/proposed-network.zip",
    "sqlitePath": "/tmp/proposed.sqlite"
  },

  "stopMatchingDistanceMeters": 100,
  "routeOverlapThreshold": 0.4,
  "generateStopPages": true,

  "timePeriods": [
    { "label": "Morning",   "start": "06:00", "end": "09:00" },
    { "label": "Midday",    "start": "09:00", "end": "16:00" },
    { "label": "Afternoon", "start": "16:00", "end": "20:00" }
  ],

  "outputPath": "/tmp/comparison-output",
  "selfContained": true
}
```

**Output structure:**

```
outputPath/
  index.html                 ← comparison overview (all routes, colour-coded status)
  css/, js/                  ← shared assets (omitted if selfContained: true)
  comparison/
    route-11.html            ← per-route timetable diff
    route-87.html
    ...
    stops/
      stop-1234.html         ← per-stop departure board (if generateStopPages: true)
      ...
```

**Reading the output:**

- The overview page shows each route as one row with a status badge: `UNCHANGED`, `MODIFIED`, `NEW`, or `REMOVED`
- Per-route pages show the existing and proposed stop lists side by side, with added stops in green and removed stops in red, plus headway comparison tables per time period
- Stop pages show all departures at one stop for both networks, sorted by time

---

## Output mode: Network diagnostics

Analyses a single GTFS feed to surface network planning issues: hidden trunk corridors, branch dilution, span/headway legibility, and circuity.

### The five diagnostics

| # | Name | What it finds |
|---|---|---|
| 1 | **Hidden trunk frequency** | Stop-pair segments where several overlapping routes together reach a threshold frequency (default ≥ 6 tph = every 10 min), but no single route does. These are latent trunk corridors that could be consolidated. |
| 2 | **Branch dilution** | Routes whose trips split into branches, collapsing a useful trunk headway into unusable branch headways. Flagged when trunk/branch ratio exceeds threshold (default 1.5×). |
| 3 | **Rail–bus connection matrix** | For each train arrival at a rail station, checks whether a bus departs within the configured wait window (default 20 min). Requires a separate rail GTFS import. |
| 4 | **Span legibility** | First departure, last departure, total trip count, and midday headway per route per direction. Easy to spot routes with very short operating hours or long midday gaps. |
| 5 | **Circuity** | Path length divided by straight-line distance (first → last stop). Values above threshold (default 2.0×) suggest detours. Circular/loop routes are excluded automatically. |

### Choosing a sample date

`diagnosticsSampleDate` must be a date within the feed's validity window **and** a day of the week that represents normal weekday service. Check the `calendar.txt` in your GTFS zip to find valid date ranges. A mid-week date during a normal school-term period is usually best.

```bash
# Quick check: list the calendar validity range in your feed
unzip -p /path/to/gtfs.zip calendar.txt | head -5
```

### Running diagnostics standalone (no timetable generation)

Use the lightweight script that skips the full timetable pipeline — useful when your GTFS has no `timetables.txt` or you only want the diagnostic report:

```bash
node scripts/run-diagnostics.mjs --configPath config-diagnostics.json
```

**Example diagnostics config:**

```json
{
  "agencies": [
    { "agencyKey": "myagency", "path": "/data/gtfs.zip" }
  ],
  "sqlitePath": "/tmp/myagency.sqlite",
  "skipImport": false,

  "diagnosticsSampleDate": "2026-04-24",
  "diagnosticsOutputPath": "/tmp/diagnostics-output",
  "selfContained": true,

  "diagnosticsHiddenTrunkMinTripsPerHour": 6,
  "diagnosticsBranchDilutionRatioThreshold": 1.5,
  "diagnosticsBranchDilutionMinTrunkTph": 1.0,
  "diagnosticsCircuityFlagThreshold": 2.0,
  "diagnosticsCircuityMinStraightLineKm": 0.2,

  "timePeriods": [
    { "label": "Early",    "start": "04:00", "end": "07:00" },
    { "label": "AM Peak",  "start": "07:00", "end": "09:00" },
    { "label": "Midday",   "start": "09:00", "end": "16:00" },
    { "label": "PM Peak",  "start": "16:00", "end": "19:00" },
    { "label": "Evening",  "start": "19:00", "end": "24:00" }
  ]
}
```

Set `"skipImport": true` on subsequent runs to reuse the imported database.

### Running diagnostics as part of the main pipeline

Add `"runDiagnostics": true` to any config and run the main CLI:

```bash
node dist/bin/gtfs-to-html.js --configPath config.json
```

Or use the `--diagnostics` CLI flag:

```bash
node dist/bin/gtfs-to-html.js --configPath config.json --diagnostics
```

### Diagnostics output

Both approaches produce the same output in `diagnosticsOutputPath/`:

```
diagnostics/
  index.html                 ← interactive HTML report (all five sections)
  hidden_trunk.csv           ← raw data for further analysis
  hidden_trunk.json
  hidden_trunk_summary.txt
  branch_dilution.csv
  branch_dilution.json
  branch_dilution_summary.txt
  span_legibility.csv
  span_legibility.json
  span_legibility_summary.txt
  circuity.csv
  circuity.json
  circuity_summary.txt
```

The HTML report includes:
- One styled section per diagnostic with summary badges
- Route toggle filter bars — check/uncheck individual routes to filter table rows
- Interactive MapLibre GL map for the hidden trunk section (when `"showMap": true`) — route toggles also filter the map
- Print-friendly layout (maps and filter bars hidden, tables scaled for A4)

---

## Self-contained HTML

By default, generated HTML files reference CSS and JS via relative paths and require the `css/` and `js/` sibling folders to be present.

With `"selfContained": true`, all local CSS and JavaScript are inlined directly into each HTML file, making it completely portable — send a single file to a client and it opens correctly in any browser.

```json
{
  "selfContained": true
}
```

**What gets inlined vs. CDN:**

| Asset | Handling |
|---|---|
| `timetable_styles.css` (~16 KB) | Inlined as `<style>` |
| `comparison_styles.css` (~8 KB) | Inlined as `<style>` |
| `diagnostics_styles.css` (~6 KB) | Inlined as `<style>` |
| `overview_styles.css` (~5 KB) | Inlined as `<style>` |
| `timetable.js`, `diagnostics.js`, `system-map.js`, etc. | Inlined as `<script>` |
| `maplibre-gl.js` (~2 MB) | CDN: `https://unpkg.com/maplibre-gl@4/...` |
| `maplibre-gl.css` (~500 KB) | CDN: `https://unpkg.com/maplibre-gl@4/...` |

Pages **without maps**: 100% self-contained, work offline.  
Pages **with maps** (`showMap: true`): require internet access for MapLibre map tiles and library.

This flag applies to all HTML output types (timetables, comparison pages, stop boards, diagnostics).

---

## Full output directory structure

```
outputPath/
│
├── css/                         ← shared stylesheets (present when selfContained: false)
│   ├── timetable_styles.css
│   ├── overview_styles.css
│   ├── comparison_styles.css
│   ├── diagnostics_styles.css
│   └── maplibre-gl.css          ← only when showMap: true
│
├── js/                          ← shared scripts (present when selfContained: false)
│   ├── timetable.js
│   ├── timetable-map.js
│   ├── system-map.js
│   ├── diagnostics.js
│   └── maplibre-gl.js           ← only when showMap: true
│
├── index.html                   ← system overview page
├── route-11.html                ← standard timetable page (one per route/period)
├── route-87.html
│
├── comparison/                  ← only when comparisonMode: true
│   ├── index.html               ← comparison overview (route status table + map)
│   ├── route-11.html            ← per-route diff timetable
│   ├── route-87.html
│   └── stops/                   ← only when generateStopPages: true
│       ├── stop-1234.html
│       └── stop-5678.html
│
└── diagnostics/                 ← only when runDiagnostics: true
    ├── index.html               ← interactive 4-section diagnostic report
    ├── hidden_trunk.csv
    ├── hidden_trunk.json
    ├── hidden_trunk_summary.txt
    ├── branch_dilution.csv
    ├── branch_dilution.json
    ├── branch_dilution_summary.txt
    ├── span_legibility.csv
    ├── span_legibility.json
    ├── span_legibility_summary.txt
    ├── circuity.csv
    └── circuity.json
```

---

## Config file examples

### 1. Standard timetables only

```json
{
  "agencies": [
    { "agencyKey": "myagency", "url": "https://example.com/gtfs.zip" }
  ],
  "sqlitePath": "/tmp/myagency.sqlite",
  "outputPath": "/tmp/myagency-html",
  "showMap": true,
  "selfContained": true
}
```

### 2. Network comparison

```json
{
  "agencies": [
    { "agencyKey": "existing", "path": "/data/existing.zip" }
  ],
  "sqlitePath": "/tmp/existing.sqlite",

  "comparisonMode": true,
  "comparisonAgency": {
    "agencyKey": "proposed",
    "path": "/data/proposed.zip",
    "sqlitePath": "/tmp/proposed.sqlite"
  },

  "stopMatchingDistanceMeters": 120,
  "routeOverlapThreshold": 0.5,
  "generateStopPages": true,

  "timePeriods": [
    { "label": "Morning",   "start": "06:30", "end": "09:30" },
    { "label": "Midday",    "start": "09:30", "end": "16:00" },
    { "label": "Afternoon", "start": "16:00", "end": "19:30" },
    { "label": "Evening",   "start": "19:30", "end": "23:00" }
  ],

  "outputPath": "/tmp/comparison-output",
  "selfContained": true,
  "brandingTitle": "Network Redesign — Route Comparison"
}
```

### 3. Diagnostics only (standalone script)

```json
{
  "agencies": [
    { "agencyKey": "myagency", "path": "/data/gtfs.zip" }
  ],
  "sqlitePath": "/tmp/myagency.sqlite",
  "skipImport": false,

  "diagnosticsSampleDate": "2026-04-24",
  "diagnosticsOutputPath": "/tmp/diagnostics",
  "selfContained": true,

  "diagnosticsHiddenTrunkMinTripsPerHour": 6,
  "diagnosticsBranchDilutionRatioThreshold": 1.5,
  "diagnosticsBranchDilutionMinTrunkTph": 1.0,
  "diagnosticsCircuityFlagThreshold": 2.0,
  "diagnosticsCircuityMinStraightLineKm": 0.2,

  "showMap": true,

  "timePeriods": [
    { "label": "Early",    "start": "04:00", "end": "07:00" },
    { "label": "AM Peak",  "start": "07:00", "end": "09:00" },
    { "label": "Midday",   "start": "09:00", "end": "16:00" },
    { "label": "PM Peak",  "start": "16:00", "end": "19:00" },
    { "label": "Evening",  "start": "19:00", "end": "24:00" }
  ]
}
```

Run with:

```bash
node scripts/run-diagnostics.mjs --configPath config-diagnostics.json
# Then open /tmp/diagnostics/index.html in a browser
```

---

## Troubleshooting

**"No active service_ids found for date X"**  
`diagnosticsSampleDate` must be a weekday that falls within the feed's calendar validity window. Open `calendar.txt` in your GTFS zip and pick a date between `start_date` and `end_date` where your desired day-of-week flag is `1`.

**"runDiagnostics is not a function" / "copyStaticAssets is not a function"**  
The `dist/` folder is stale or missing. Run `pnpm build` and try again.

**"Cannot find module '…/dist/index.js'"**  
Run `pnpm install && pnpm build` from the repository root.

**MapLibre map does not appear**  
When `showMap: true` with `selfContained: true`, MapLibre loads from the unpkg CDN — an internet connection is required. If you see a blank map container, open the browser's developer tools and check the Network tab for failed CDN requests.

**GTFS import takes a long time on repeated runs**  
Add `"skipImport": true` to your config. The SQLite database at `sqlitePath` persists between runs and can be reused as long as the GTFS feed has not changed.

**Branch dilution flags every route**  
Lower-frequency routes (e.g. one bus per hour) may be flagged when branches have zero departures in a time band. Raise `diagnosticsBranchDilutionMinTrunkTph` (e.g. to `2.0`) to only flag routes that have meaningful trunk frequency.

**Circuity shows extreme ratios (∞ or 400×)**  
These are typically loop routes whose first and last stop are nearly identical (straight-line distance ≈ 0). They are excluded automatically when `straightKm < diagnosticsCircuityMinStraightLineKm` (default 0.2 km). If some loops are still appearing, raise this threshold.

**Comparison finds too few matched routes**  
Reduce `routeOverlapThreshold` (e.g. to `0.3`) or increase `stopMatchingDistanceMeters` (e.g. to `200`) if routes were renumbered or stops were relocated in the proposed network.

---

## Development

```bash
pnpm install       # install dependencies
pnpm build         # compile TypeScript + vendor browser libs
```

The build is a single ESM bundle in `dist/` produced by [tsup](https://tsup.egoist.dev). TypeScript declaration files are also emitted (DTS). Some DTS errors in upstream files are pre-existing and do not affect runtime.

## License

MIT — see [LICENSE](LICENSE).

Based on [gtfs-to-html](https://github.com/blinktaginc/gtfs-to-html) by [BlinkTagInc](https://github.com/blinktaginc), also MIT licensed.
