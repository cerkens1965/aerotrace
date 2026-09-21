# AirKi — conventions for building with this library

AirKi is a connected flight recorder for light aviation. This library is the AirKi Dashboard UI: a club web app (Live map, In flight, Logbook, Loop replay, Fleet, Admin). Build every screen from these components and tokens.

## Setup

No provider or theme wrapper. Link `styles.css` once: it defines the colour tokens and loads Instrument Sans and Geist Mono. Components style themselves (inline styles from the tokens); some inject one small shared stylesheet on first render (focus ring, skeleton pulse, drawer width).

## Brand rules (non-negotiable)

- The name is always written **AirKi** — never AIRKI, never `text-transform: uppercase` on anything that can contain it.
- No gradients, no shadows. Borders are 1 px. Radius 4 (buttons, chips), 6 (cards, tables), 999 (dots).
- Amber `#F5A623` is an accent and a "transient / caution" status only — **never a text colour**, never a button fill.
- Status colours: green `#22C55E` confirms, amber is transient, grey `#8D9096` is off. **No red anywhere**, including errors and destructive actions.
- Words in Instrument Sans (`var(--font-sans)`); every figure, time, registration, code and technical label in Geist Mono (`var(--font-mono)`).
- Page ground is paper `#F4F2ED`; cards are white with a 1 px `#DDD9D2` border; metric panels are ink `#141414` with white figures and `#9A9A94` labels.
- Customer copy says "AirKi Core" (the unit) and "AirKi View" (the display); AKC / AKV only in technical labels. "Loop" = flight replay, plain text.
- UI text is English (UK). Dates as `21 Sep 2026 · 14:32 UTC`; speeds in kt, altitudes in ft, durations `HH:MM`; missing value `−−−`.

## Tokens

CSS variables from `styles.css`: `--ink`, `--paper`, `--card`, `--graphite`, `--etch`, `--rule`, `--rule-dark`, `--muted-dark`, `--amber`, `--ok`, `--info`, `--font-sans`, `--font-mono`.
The same values in JS: `window.AirKi.T` (`T.ink`, `T.paper`, `T.card`, `T.graphite`, `T.etch`, `T.rule`, `T.ruleDark`, `T.mutedDark`, `T.amber`, `T.ok`, `T.info`, `T.white`, `T.sans`, `T.mono`, `T.radius.sm|md|pill`, `T.border`). Text helpers: `labelStyle(color)` (mono 10 px, 0.08em — write the label in capitals yourself), `monoStyle(size, color)`, `valueStyle(size, color)`, `headingStyle(size, color)`.

## Components (read `components/general/<Name>/<Name>.prompt.md` before use)

`Button` (primary / secondary / ghost / danger, `onInk` on dark panels, `confirm` = two-step click), `MetricCard`, `StatusDot`, `DataTable`, `Tabs`, `Drawer` (forms and detail panels open as a right drawer, not a modal), `EmptyState`, `Banner` (info / caution / ok), `Skeleton`, `Icon` (20 names, 1.5 px strokes), `AirKiMark`, `AirKiLockup`.

## Example

```jsx
const { T, labelStyle, MetricCard, DataTable, StatusDot, Button } = window.AirKi;

function FleetToday({ flights }) {
  return (
    <div style={{ background: T.paper, padding: 24, fontFamily: T.sans, color: T.ink }}>
      <h1 style={{ margin: '0 0 16px', fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em' }}>Live · fleet today</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 16 }}>
        <MetricCard label="FJFVB · ALT FT" value="3450" status={{ tone: 'ok', text: 'In flight' }} />
        <MetricCard label="FJVUD · GS KT" value="104" status={{ tone: 'ok', text: 'In flight' }} />
        <MetricCard label="OOH14 · LOGGED H" value="1842.6" status={{ tone: 'caution', text: 'On ground' }} />
      </div>
      <DataTable rows={flights} columns={[
        { key: 'route', label: 'FLIGHT' },
        { key: 'pilot', label: 'PILOT' },
        { key: 'block', label: 'BLOCK', mono: true, align: 'right' },
        { key: 'status', label: 'STATUS', render: f => <StatusDot tone={f.validated ? 'ok' : 'caution'} text={f.validated ? 'VALIDATED' : 'TO ASSIGN'} /> },
        { key: 'open', label: '', align: 'right', render: () => <Button size="sm" icon="play">Open Loop</Button> },
      ]} />
    </div>
  );
}
```
