# Aerotrace — GitHub Copilot Instructions

## Project Overview

**Aerotrace** is a professional aviation instructor dashboard for flight replay, live traffic monitoring, and post-flight debriefing. It targets flight schools and aviation instructors who need to replay student flights overlaid with real-time ATC traffic data.

**This is a safety-critical aviation application. Code must be reliable and well-documented.**

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite 5 |
| Language | JavaScript (JSX) — no TypeScript for now |
| Map | MapLibre GL JS |
| Map tiles | MapTiler (outdoor-v2 default) |
| Airspaces | OpenAIP vector tiles |
| Live traffic | SafeSky UAV API v2 HMAC via Node proxy |
| Auth | Firebase Authentication (Google SSO) |
| Database | Firebase Firestore |
| File storage | Firebase Storage (CSV flight logs G3X) |
| Hosting | Firebase Hosting |
| Backend proxy | Node.js + Express (SafeSky HMAC auth, port 3001) |
| Hardware client | ESP32 SIM7600 → Firestore REST API direct |

---

## Repository Structure

```
aerotrace/
├── .github/
│   └── copilot-instructions.md
├── dashboard/
│   ├── src/
│   │   ├── App.jsx                          ← React Router + role guard
│   │   ├── pages/
│   │   │   ├── LivePage.jsx                 ← Wraps AerotraceMap
│   │   │   ├── EnVolPage.jsx                ← Fleet status (instructor/admin)
│   │   │   ├── ReplayPage.jsx               ← Full replay controller
│   │   │   └── AdminPage.jsx                ← Club/Aircraft/Pilots CRUD
│   │   ├── components/
│   │   │   ├── layout/
│   │   │   │   └── Header.jsx               ← Fixed header amber #F5A623
│   │   │   ├── map/
│   │   │   │   ├── AerotraceMap.jsx         ← LIVE map MapLibre + SafeSky
│   │   │   │   └── ReplayMap.jsx            ← REPLAY map MapLibre + AIP + traces
│   │   │   ├── replay/
│   │   │   │   └── FlightCharts.jsx         ← Synchronized flight parameter charts
│   │   │   └── ui/
│   │   │       └── SixPack.jsx              ← 6 canvas instruments ADI/badin/alti/vsi/hdg/turn
│   │   ├── hooks/
│   │   │   ├── useFleet.js                  ← Fleet status combining SafeSky + FDR + Firestore
│   │   │   └── useSafeSky.js                ← SafeSky polling hook (5s)
│   │   ├── utils/
│   │   │   └── csvParser.js                 ← Garmin G3X CSV parser (18+ columns, 1Hz)
│   │   └── firebase/
│   │       └── config.js                    ← Firebase init (auth, db, storage)
│   └── proxy/
│       └── server.js                        ← Node/Express SafeSky HMAC proxy (port 3001)
└── fdr-firmware/                            ← ESP32 FreeRTOS firmware (étapes 1+2 done)
```

---

## Routing & Roles

```
/ → /live
/live          → LivePage      (all roles)
/en-vol        → EnVolPage     (instructor, admin)
/replay        → ReplayPage    (all roles)
/replay/:id    → ReplayPage    (all roles)
/admin         → AdminPage     (admin only)
```

Roles: `student` | `pilot` | `instructor` | `admin`
Role stored in Firestore `/users/{uid}.role`

---

## Design Rules — CRITICAL

```
text color     → ALWAYS #ffffff (never rgba gray on dark bg)
accent color   → #F5A623 (amber)
borders/bg     → rgba subtils ok (rgba(255,255,255,0.07) etc.)
placeholders   → rgba gray ok (champ vide = indication)
font           → monospace partout
background     → #050814
panel bg       → rgba(10,14,30,0.95)
```

**Never use low-opacity white for text.** Only for borders/backgrounds.

---

## Firestore Schema

```
/users/{uid}
  role: "student" | "pilot" | "instructor" | "admin"
  clubId: string
  displayName, email, createdAt

/clubs/{clubId}
  name, icao, city, country, phone, email, website

/aircraft/{id}
  registration, type, icao24, callSign, clubId, active, archived

/pilots/{id}
  firstName, lastName, email, role, birthDate, licenceDate
  licences: string[]   ← ['PPL','ULM','IR',...]
  clubId, archived

/fdr_status/{icao24}           ← Written by ESP32 every 5s
  mode: "MODE_PREFLIGHT" | "MODE_FLIGHT" | "MODE_POSTFLIGHT" | "MODE_SLEEP"
  lat, lon, alt_m, spd_kt, hdg, rpm, co_ppm
  pilotName, flightStart, updatedAt, clubId

/flights/{flightId}
  pilotId, aircraftIdent, fileName
  csvStoragePath, csvUrl
  startTs, endTs, duration
  maxAlt, maxSpd, maxG, maxRpm, bounds
  uploadedAt
```

---

## CSV Flight Log Format (Garmin G3X)

3 header rows + data at 1Hz. Key columns:
```
Lcl Date, Lcl Time, Latitude, Longitude
AltInd (ft), AltGPS, AGL
IAS (kt), GndSpd, TRK, HDG
VSpd (fpm), Pitch, Roll, NormAc, LatAc
E1 RPM, OAT, E1 CHT1, E1 EGT1
```

Parser: `src/utils/csvParser.js` — exports `parseG3XCSV`, `subsampleFrames`, `getFrameAtTime`

---

## Flight Phases

```javascript
if (co_ppm > 50 || Math.abs(normAc) > 2.5) → CRITICAL
else if (agl < 150)                          → APPROACH
else if (Math.abs(roll) > 20)               → MANEUVER
else if (spd > 30 || rpm > 800)             → CRUISE
else                                         → GROUND
```

Trail colors: GROUND=#fff, CRUISE=#22c55e, MANEUVER=#f97316, APPROACH=#F5A623, CRITICAL=#ef4444

---

## Map Configuration

### AerotraceMap (LIVE)
- Center: EBBY Baisy-Thy `[4.4347, 50.5686]`
- Zoom: 9, default style: `dataviz-light`
- SafeSky polling: 5s via proxy `http://localhost:3001`
- AIP panel: CTR/TMA/DANGER sliders + AIRPORTS checkboxes + TRAFFIC alt filter
- Basemaps: Light / Dark / Topo / Satellite / Basic

### ReplayMap (REPLAY)
- Fits bounds of loaded flight automatically
- Ghost trace: gray #999, 2.5px, opacity 0.65 (future path)
- Played trace: 6px colored by flight phase
- Aircraft marker: `/icons/VL3.svg`, rotated by HDG, inverted on dark/satellite
- AIP panel: identical to LIVE minus traffic
- Basemaps: same 5 styles
- 2D/3D toggle (3D uses MapTiler terrain-rgb-v2, pitch 60°)

---

## OpenAIP Layer Filters

```javascript
// ALWAYS use string type values, not integers
CTR:    ['==', ['get', 'type'], 'ctr']
TMA:    ['in', ['get', 'type'], ['literal', ['tma', 'cta']]]
DANGER: ['in', ['get', 'type'], ['literal', ['danger', 'restricted', 'prohibited']]]
// Airport field: 'icao_code' (not 'icaoCode')
```

---

## SafeSky Integration

```javascript
// Always via Node proxy — never direct from browser
fetch('http://localhost:3001/safesky/traffic?lat=50.5686&lon=4.4347')
// Returns SafeSky nearby aircraft array
// Center: EBBY (50.5686, 4.4347)
```

---

## SliderTrack Component (reuse everywhere)

```jsx
function SliderTrack({ value, max = 30, color, onChange }) {
  return (
    <div style={{ position: 'relative', height: 10, display: 'flex', alignItems: 'center' }}>
      <div style={{ position: 'absolute', width: '100%', height: 1, background: 'rgba(255,255,255,0.08)', borderRadius: 1 }} />
      <div style={{ position: 'absolute', width: `${(value/max)*100}%`, height: 1, background: color, borderRadius: 1 }} />
      <div style={{ position: 'absolute', left: `calc(${(value/max)*100}% - 4px)`, width: 8, height: 8, borderRadius: '50%', background: color, pointerEvents: 'none' }} />
      <input type="range" min={0} max={max} value={value} onChange={e => onChange(Number(e.target.value))}
        style={{ position: 'absolute', width: '100%', opacity: 0, cursor: 'pointer', height: 10, margin: 0, background: 'transparent', WebkitAppearance: 'none' }} />
    </div>
  )
}
```

---

## FDR Hardware (ESP32)

- **LILYGO T-SIM7600G-H** — main MCU + 4G LTE
- **LILYGO T-RGB 2.8"** — cockpit display (BLE client)
- SIM: Emnify, APN=`em`
- Steps 1+2 complete, hardware on order
- Known bug: `g_fileFligh` → `g_fileFlight` in `SDUtil::flushRing()`
- Pilot ID: PIN code (short term) → NFC PN532 (future)

---

## Do Not

- ❌ Never use gray/low-opacity text on dark backgrounds → use #ffffff
- ❌ Never call SafeSky directly from browser → always via proxy
- ❌ Never use Mapbox GL JS → MapLibre only
- ❌ Never use integer filters for OpenAIP → use string type values
- ❌ Never commit `.env.local` or `serviceAccountKey.json`
- ❌ Never delete Firestore documents → use `archived: true`
- ❌ Never use class components → functional only
