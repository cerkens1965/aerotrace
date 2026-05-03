# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> A much more detailed instruction set lives at `../.github/copilot-instructions.md` and is the source of truth for design rules, Firestore schema, CSV format, 3D camera math, and all the "Do Not" gotchas. Read it before any non-trivial change. This file is the orientation layer — it points at the architecture and the things that are easy to break.

## Commands

Two processes must run together for the LIVE map to work:

```bash
# Terminal 1 — SafeSky HMAC proxy (port 3001)
cd dashboard/proxy && node server.js

# Terminal 2 — Vite dev server (port 5173)
cd dashboard && npm run dev
```

Other scripts (run from `dashboard/`):
- `npm run build` — production build via Vite
- `npm run lint` — ESLint (flat config, `eslint.config.js`)
- `npm run preview` — preview built bundle

The proxy needs `SAFESKY_KEY` in `dashboard/.env.local` (or its own env) — it will `process.exit(1)` without it.

There is no test runner configured. Don't claim a feature works because the code compiles — for UI changes, exercise the page in a browser.

## Repo layout

This is a multi-package monorepo. The Claude working directory is `dashboard/`, but several things live one level up:

```
aerotrace/
├── dashboard/              ← React + Vite app (this directory)
│   ├── src/                ← App code
│   ├── proxy/              ← Separate Node/Express server (own package.json)
│   └── .env.local          ← Firebase + SafeSky keys (never commit)
├── firebase.json           ← Hosting/Firestore config (parent dir)
├── firestore.rules         ← Currently OPEN until 2026-05-28 — do not rely on rules for auth
├── firestore.indexes.json
├── seed.js                 ← One-shot Firestore seeder
└── fdr-firmware/           ← ESP32 FreeRTOS firmware (separate toolchain)
```

When you change Firestore rules/indexes, they live in the parent directory, not in `dashboard/`.

## Architecture

### Three surfaces, one app

The dashboard is a single SPA with three functional surfaces, gated by role from `/users/{uid}.role` in Firestore:

| Page | Route | Roles | Purpose |
|------|-------|-------|---------|
| LivePage | `/live` | all | Live map + SafeSky traffic + AIP airspace |
| EnVolPage | `/en-vol` | instructor, admin | Fleet status from `/fdr_status/*` |
| ReplayPage | `/replay/:flightId?` | all | Post-flight replay with 2D/3D map, charts, six-pack |
| LogbookPage | `/logbook` | instructor, admin | Flight CSV → pilot/aircraft assignment |
| AdminPage | `/admin` | admin | CRUD for clubs/aircraft/pilots |

Auth flow lives entirely in `src/App.jsx`:
- Firebase `onAuthStateChanged` → fetch `/users/{uid}` → if missing, auto-create with `role: 'user'`.
- `RequireRole` is the only guard. Platform roles: `user | instructor | admin`. Bare `'user'` accounts land on `/live` and `/replay` only.
- Note: `pilotRole` on flight docs (`student | pilot`) is a **separate** field used only for flight-type derivation — not the same as the platform `role`.

### Data flow

```
ESP32 FDR ──REST──▶ /fdr_status/{icao24}   (every 5s, lat/lon/alt/spd/mode/...)
                          │
                          ▼
                    useFleet hook ──▶ EnVolPage / LivePage marker
                          ▲
                          │
SafeSky API ──HMAC──▶ proxy:3001 ──▶ useSafeSky (5s poll) ──▶ AerotraceMap
                                         (ambient nearby traffic)

G3X CSV upload ──▶ Firebase Storage
                        │
                        ▼
              /flights/{flightId}  (metadata + csvStoragePath)
                        │
                        ▼
              ReplayPage (download CSV → parseG3XCSV → frames @ 1Hz)
```

`src/utils/csvParser.js` is the single source for G3X CSV parsing — `parseG3XCSV`, `subsampleFrames`, `getFrameAtTime`. Treat its `frame.bearing` (already TRK-or-corrected-HDG) as authoritative; do not re-derive heading from `frame.hdg` for camera/marker orientation.

### Map components

Two MapLibre maps with shared design but very different responsibilities:

- `components/map/AerotraceMap.jsx` — LIVE. SafeSky polling, AIP airspaces (CTR/TMA/DANGER sliders + AIRPORTS), basemap switcher, traffic altitude filter.
- `components/map/ReplayMap.jsx` — REPLAY. Frame-driven aircraft marker, ghost trace + colored played trace, 2D/3D cockpit view, terrain DEM with tile pre-caching, AIP panel mirroring LIVE minus traffic.

The 2D/3D toggle is rendered in `ReplayPage.jsx` (overlaid on the map), **not** inside `ReplayMap.jsx`. Keep it that way.

The aircraft marker is `/icons/VL3.svg` injected as an HTML `<img>` element wrapped in `maplibregl.Marker({ element })` — MapLibre's `map.loadImage()` does not support SVG via WebGL.

## Critical conventions (read copilot-instructions.md before changing any of these)

These are the failure modes that have already cost time. The detailed rationale is in `../.github/copilot-instructions.md`; the short version:

**Theme split.** Pages are LIGHT (`#f0f2f8` bg, `#0a0e1e` text, monospace). Maps (`AerotraceMap`, `ReplayMap`) are DARK (`#050814` bg, `#ffffff` text). Never use gray/low-opacity text on dark backgrounds — pure `#ffffff` only. Accent is `#F5A623` everywhere.

**SliderRow / SliderTrack must be top-level.** Defining a slider component inside another component remounts it every render and breaks the drag interaction. Declare these *outside* and above the page/component that uses them.

**AIP layer toggle clickable area.** Put `onClick` on the row's parent `<div>`, not on the inner `<span>` label.

**OpenAIP filters use string types**, not integers: `['==', ['get', 'type'], 'ctr']`, `['in', ['get', 'type'], ['literal', ['tma','cta']]]`. Airport key is `icao_code`, not `icaoCode`.

**3D camera math (ReplayMap).** Use `AltGPS - queryTerrainElevation()` for true AGL — never `frame.agl` (often null/0 from G3X), never `AltInd` (baro). Terrain `exaggeration` must stay at `1.0` or the camera goes through the ground. `easeTo` duration must be `< frameInterval` (use `frameInterval * 0.75` with linear easing) or MapLibre snaps back. Pre-cache 25 DEM tiles via silent `jumpTo` before starting 3D replay.

**SafeSky never from the browser.** Always go through `localhost:3001`. The proxy does the HMAC signing.

**Soft-delete only.** Don't `deleteDoc` from Firestore — set `archived: true`.

**Never commit** `.env.local`, `serviceAccountKey.json`, or any Firebase admin keys.

## File-edit workflow caveat

The project lives on iCloud Drive:

```
/Users/c.erkens/Library/Mobile Documents/com~apple~CloudDocs/00 - A.DVP DIGITAL FLIGHT RECORDER/CODAGE/aerotrace/dashboard
```

Spaces and `~` in the path mean shell commands need quoting. The user historically uses a "Claude generates → user uploads → `cp` into terminal" workflow for the most safety-critical files (notably `ReplayMap.jsx`). When asked to edit those files, prefer producing the full file content for review rather than partial in-place edits unless the user has explicitly opted into direct editing for the session.

Known-good baseline commit for the replay flow: `facef2e`.
