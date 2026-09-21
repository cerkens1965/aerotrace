# design-sync — notes for the next run (AirKi Dashboard → Claude Design project 9c2df9a6…)

## Setup specifics
- Package shape, no Storybook. The dashboard is an app, not a published package: no `dist/`, no `.d.ts`. The converter builds from `cfg.entry = ./src/components/ui/index.js` (the library barrel), `srcDir = src/components/ui`.
- Components are declared explicitly in `componentSrcMap` (no .d.ts to discover them). `SixPack` is excluded (flight-instrument canvas, app-specific).
- Prop contracts are hand-written in `dtsPropsFor` — **update them whenever a component's props change** (source of truth: the function signature in `src/components/ui/<Name>.jsx`).
- Tokens and fonts live in ONE file, `src/styles/airki-tokens.css` (imported by `src/index.css` for the app, used as `cssEntry` here). Fonts load from Google Fonts via `@import` (`[FONT_REMOTE]`, expected).
- Card modes: `Drawer` single 960×540 (overlay); `DataTable`, `MetricCard`, `Skeleton` column (wide stories, `[GRID_OVERFLOW]` otherwise).
- Previews import from `'dashboard'` (the package name); onInk variants wrap in a `#141414` div.
- Playwright + chromium installed in `.ds-sync/` (chromium-headless-shell-1243 in ~/Library/Caches/ms-playwright).

## Commands
```
node .ds-sync/resync.mjs --config .design-sync/config.json --node-modules ./node_modules --out ./ds-bundle [--remote .design-sync/.cache/remote-sync.json]
```

## Known render warns
- none (17/17 clean).

## Re-sync risks
- `dtsPropsFor` is hand-maintained: a new or renamed prop in a component is invisible to the design agent until added here.
- `conventions.md` names tokens (`--ink`…, `T.*`) and components; the next run must re-validate those names against the fresh bundle.
- (22/09) Field, Input, Select (exported from Input.jsx), Chip, Toggle added to the library and synced (17 components). `fieldStyle()` in tokens.js is the shared field style for bespoke inputs. Still local: Admin `Label`/`Hint`/`ReadOnly`/`Section`, Fleet `Section`, SelectClub ink inputs.
- Fonts depend on Google Fonts at runtime (network).
