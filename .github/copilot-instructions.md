# Aerotrace — GitHub Copilot Instructions

## Project Overview

**Aerotrace** is a professional aviation instructor dashboard for flight replay, live traffic monitoring, and post-flight debriefing. It targets flight schools and aviation instructors who need to replay student flights overlaid with real-time ATC traffic data.

**This is a safety-critical aviation application. Code must be reliable, typed, and well-documented.**

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite 5 |
| Language | JavaScript (JSX) — no TypeScript for now |
| Map | MapLibre GL JS |
| Map tiles | MapTiler (outdoor style) |
| Airspaces | OpenAIP vector tiles + REST API |
| Live traffic | SafeSky API v1 (via Node proxy) |
| Auth | Firebase Authentication (Google SSO) |
| Database | Firebase Firestore |
| File storage | Firebase Storage (CSV flight logs) |
| Hosting | Firebase Hosting |
| Backend proxy | Node.js + Express (SafeSky HMAC auth) |
| Hardware client | ESP32 SIM7600 → Firestore REST API direct |

---

## Repository Structure

```
aerotrace/
├── .github/
│   └── copilot-instructions.md
├── src/
│   ├── components/
│   │   ├── map/
│   │   │   ├── AerotraceMap.jsx        ← Main MapLibre component
│   │   │   ├── AirspaceLayer.jsx       ← OpenAIP CTR/TMA/R/D/P layers
│   │   │   ├── TrafficLayer.jsx        ← SafeSky live traffic markers
│   │   │   ├── FlightReplayLayer.jsx   ← Ghost trace + trail + aircraft icon
│   │   │   └── MapControls.jsx         ← Layer toggles, zoom, center
│   │   ├── replay/
│   │   │   ├── ReplayController.jsx    ← Play/pause/scrub timeline
│   │   │   ├── ReplayCharts.jsx        ← 9 synchronized flight charts
│   │   │   └── FlightSelector.jsx      ← Load flight from Firestore/Storage
│   │   ├── traffic/
│   │   │   ├── TrafficPopup.jsx        ← Click popup: callsign/alt/spd/hdg
│   │   │   └── TrafficLegend.jsx       ← Aircraft type icons legend
│   │   ├── alerts/
│   │   │   └── AirproxReport.jsx       ← AIRPROX export PDF
│   │   ├── auth/
│   │   │   └── LoginPage.jsx           ← Firebase Google SSO
│   │   └── ui/
│   │       ├── ADI.jsx                 ← Attitude Direction Indicator
│   │       ├── InstrumentPanel.jsx     ← Live flight parameters
│   │       └── Sidebar.jsx             ← Right panel collapsible
│   ├── firebase/
│   │   ├── config.js                   ← Firebase app init
│   │   ├── auth.js                     ← Auth helpers
│   │   ├── firestore.js                ← Firestore CRUD helpers
│   │   └── storage.js                  ← CSV upload/download helpers
│   ├── hooks/
│   │   ├── useReplay.js                ← Flight replay state machine
│   │   ├── useSafeSky.js               ← SafeSky polling hook (5s)
│   │   ├── useFirestore.js             ← Firestore real-time listener
│   │   └── useMapLibre.js              ← Map instance ref + controls
│   ├── utils/
│   │   ├── csvParser.js                ← Parse FDR CSV 18 columns
│   │   ├── flightPhases.js             ← GROUND/CRUISE/MANEUVER/APPROACH/CRITICAL
│   │   ├── geoUtils.js                 ← Bearing, distance, AGL helpers
│   │   └── airprox.js                  ← AIRPROX detection logic
│   ├── constants/
│   │   ├── mapStyles.js                ← MapTiler style URLs
│   │   └── airspaceTypes.js            ← OpenAIP type codes
│   ├── App.jsx
│   └── main.jsx
├── proxy/
│   └── server.js                       ← Node/Express SafeSky HMAC proxy (port 3001)
├── public/
│   └── icons/
│       ├── VL3.svg                     ← GA fixed-wing, nose NORTH, transparent bg
│       ├── helicopter.svg
│       ├── glider.svg
│       ├── drone.svg
│       └── airliner.svg
├── .env.local                          ← never commit
├── firebase.json
├── .firebaserc
├── vite.config.js
└── package.json
```

---

## Environment Variables

```bash
# .env.local — NEVER commit this file
VITE_MAPTILER_KEY=<maptiler_api_key>
VITE_OPENAIP_KEY=ac134ca9a623587f3c387dab1b9e3d0e
VITE_FIREBASE_API_KEY=<firebase_api_key>
VITE_FIREBASE_AUTH_DOMAIN=<project>.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=<project_id>
VITE_FIREBASE_STORAGE_BUCKET=<project>.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=<sender_id>
VITE_FIREBASE_APP_ID=<app_id>

# proxy/server.js only — not exposed to frontend
SAFESKY_KEY=sk_test_d74f45601570557f758c67a147ba32fe3181944c9241a2b9
```

---

## Firestore Data Schema

```
/users/{uid}
  displayName: string
  email: string
  role: "instructor" | "student" | "admin"
  createdAt: timestamp

/flights/{flightId}
  pilotId: string (uid ref)
  aircraftType: string        // "VL3", "DA40", etc.
  icao24: string              // for ADS-B dedup
  callSign: string
  departureIcao: string       // "LFAE"
  arrivalIcao: string         // "EBBY"
  date: timestamp
  durationSec: number
  csvStoragePath: string      // Firebase Storage path
  phases: array               // [{type, startTs, endTs}]
  maxG: number
  maxCo: number
  hasAirprox: boolean
  uploadedAt: timestamp

/flights/{flightId}/traffic/{trafficId}
  ts: timestamp
  icao24: string
  callSign: string
  lat: number
  lon: number
  alt_ft: number
  speed_kt: number
  course: number
  type: string                // SafeSky aircraft type
  source: "safesky" | "adsb" | "flarm"
  invisible: boolean          // true if not on SafeSky

/airprox/{airproxId}
  flightId: string
  ts: timestamp
  lat: number
  lon: number
  ourAlt_ft: number
  trafficAlt_ft: number
  separation_m: number
  trafficCallSign: string
  severity: "A" | "B" | "C"
  exported: boolean
```

---

## CSV Flight Log Format (FDR Hardware)

18 columns, 4Hz recording:

```
ts, lat, lon, alt_m, spd_kt, hdg, ax, ay, az, gx, gy, gz, pres_hpa, temp_c, rpm, co_ppm, flarm_rx, adsb_rx
```

- `ts` : Unix timestamp milliseconds
- `alt_m` : altitude MSL in meters
- `spd_kt` : IAS in knots
- `hdg` : magnetic heading degrees
- `ax/ay/az` : accelerometer m/s² (az=1g normal)
- `gx/gy/gz` : gyroscope °/s
- `co_ppm` : Carbon monoxide PPM (alert > 50ppm)
- `flarm_rx` / `adsb_rx` : traffic count received

---

## Flight Phases Detection

```javascript
// Detect flight phase from a CSV row
function detectPhase(row, prevRows) {
  if (row.co_ppm > 50 || Math.abs(row.az) > 2.5) return 'CRITICAL'
  if (row.alt_m < 150 /* AGL */) return 'APPROACH'
  if (Math.abs(row.gz) > 3) return 'MANEUVER'
  if (row.spd_kt > 30 || row.rpm > 800) return 'CRUISE'
  return 'GROUND'
}
```

---

## Map Configuration

```javascript
// MapLibre init — always use these defaults
const map = new maplibregl.Map({
  container: 'map',
  style: `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`,
  center: [4.35, 50.85],   // Brussels default
  zoom: 9,
  pitch: 0,
  bearing: 0,
})

// OpenAIP airspace source
map.addSource('openaip', {
  type: 'vector',
  tiles: [`https://api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.pbf?apiKey=${OPENAIP_KEY}`],
  minzoom: 0,
  maxzoom: 14,
})
```

---

## Aircraft Icons

All SVG icons in `/public/icons/` share these constraints:
- **Nose pointing NORTH** (up, 0°)
- Transparent background
- Single color fill (#000000 for dark maps, use CSS filter for color)
- 52×52px render size
- Rotation applied via CSS: `transform: rotate(${course}deg)`

Icon mapping by SafeSky aircraft type:
```javascript
const ICON_MAP = {
  1: 'VL3.svg',          // GA fixed-wing
  2: 'glider.svg',       // Glider / motorglider
  3: 'helicopter.svg',   // Helicopter
  4: 'drone.svg',        // UAS / drone
  5: 'airliner.svg',     // Airliner
  default: 'VL3.svg',
}
```

---

## SafeSky Integration

**Always go through the Node proxy — never call SafeSky directly from the browser.**

```javascript
// Frontend polling — every 5s
const fetchTraffic = async (lat, lon) => {
  const res = await fetch(`http://localhost:3001/safesky/traffic?lat=${lat}&lon=${lon}`)
  return res.json() // returns SafeSky nearby aircraft array
}

// proxy/server.js endpoint
// POST https://api.safesky.app/v1/uav?show_nearby_traffic=true
// Auth: x-api-key header + HMAC signature
// Returns: { nearby_traffic: [ { id, call_sign, lat, lon, alt_ft, course, speed, type } ] }
```

---

## ESP32 → Firestore Direct

The FDR hardware (ESP32 SIM7600) writes directly to Firestore REST API:

```
POST https://firestore.googleapis.com/v1/projects/{projectId}/databases/(default)/documents/flights/{flightId}/frames
Authorization: Bearer {serviceAccountJWT}
Content-Type: application/json
```

**Never use Firebase SDK on ESP32 — REST API only, JWT auth via service account.**

---

## Coding Standards

### General
- **JSX functional components only** — no class components
- **Custom hooks** for all data fetching and stateful logic
- **Named exports** preferred over default exports (except pages)
- **No inline styles** except for dynamic values (rotation, colors from data)
- Use **CSS Modules** or **CSS variables** for styling
- Always handle **loading** and **error** states explicitly

### Map
- Always wrap MapLibre operations in `map.on('load', ...)` or check `map.loaded()`
- Clean up sources and layers in `useEffect` return functions
- Never mutate map sources directly — always `removeLayer → removeSource → addSource → addLayer`

### Firebase
- Always use **Firestore security rules** — never expose raw data
- Batch writes when inserting CSV frames (max 500 per batch)
- Use `onSnapshot` for real-time listeners, clean up on unmount

### Safety-critical rules
- **Never silently swallow errors** — always log to console AND show UI feedback
- **Validate all CSV rows** before writing to Firestore
- **AIRPROX detection must run on every traffic update** — never skip
- CO alert (> 50ppm) must trigger immediate visual alert regardless of current page

---

## Key Business Rules

1. **Invisible traffic** = aircraft detected by FDR (ADS-B/FLARM) but absent from SafeSky → stored separately, shown in orange on replay
2. **AIRPROX** = separation < 500m horizontal AND < 300ft vertical → auto-detected, timestamped, geolocated, exportable as PDF
3. **Trail color** during replay:
   - Red → normal flight
   - Orange → G-load > 1.2g
   - Yellow → G-load > 1.4g
   - Red flashing → CRITICAL phase (CO or G > 2.5g)
4. **Post-flight transfer** = ESP32 uploads complete CSV on battery after engine shutdown, resume on next boot if interrupted
5. **Dead reckoning** = FastAPI/Firestore receives position every 50m moved OR always during APPROACH/CRITICAL phases

---

## Running Locally

```bash
# Install
npm install

# Terminal 1 — SafeSky proxy
cd proxy && node server.js    # http://localhost:3001

# Terminal 2 — Frontend
npm run dev                   # http://localhost:5173

# Firebase emulator (optional)
firebase emulators:start
```

---

## Do Not

- ❌ Never commit `.env.local` or any API keys
- ❌ Never call SafeSky API directly from browser (CORS + key exposure)
- ❌ Never use Mapbox GL JS — this project uses **MapLibre GL JS**
- ❌ Never use class components
- ❌ Never store Firebase service account JSON in the repo
- ❌ Never use `any` type or disable ESLint rules without comment
- ❌ Never delete Firestore documents — use `archived: true` flag instead
- ❌ Never show raw GPS coordinates to end users without formatting

---

## Glossary

| Term | Meaning |
|---|---|
| FDR | Flight Data Recorder (the ESP32 hardware box) |
| REX | Retour d'EXpérience (French for post-flight debrief) |
| AGL | Above Ground Level |
| IAS | Indicated Air Speed |
| OGN | Open Glider Network (FLARM network) |
| AIRPROX | Aircraft proximity event (near-miss) |
| FLARM | Collision avoidance system used in GA aviation |
| ADS-B | Automatic Dependent Surveillance–Broadcast |
| ICAO24 | Unique 24-bit aircraft identifier |
| CTR | Control Zone (airspace) |
| TMA | Terminal Manoeuvring Area (airspace) |
| SafeSky | Real-time aviation traffic API used in this project |
