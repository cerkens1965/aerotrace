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

### Pages thème BLANC (défaut)
```
background     → #f0f2f8
panel bg       → rgba(255,255,255,0.97)
border         → rgba(0,0,0,0.08)
text color     → #0a0e1e (JAMAIS blanc sur fond blanc)
mid color      → rgba(10,14,30,0.5)
accent color   → #F5A623 (amber)
font           → monospace partout
```

Pages thème blanc : **LivePage, EnVolPage, ReplayPage, AdminPage, LogbookPage, Header, FlightCharts**

### Composants thème SOMBRE (exception)
```
background     → #050814
panel bg       → rgba(10,14,30,0.95)
border         → rgba(255,255,255,0.07)
text color     → #ffffff TOUJOURS
accent color   → #F5A623 (amber)
```

Composants thème sombre : **ReplayMap, AerotraceMap** (maps MapLibre — restent dark)

**Règle absolue** : jamais de texte gris/low-opacity sur fond sombre → `#ffffff` uniquement.
Seules exceptions : placeholders champs vides, labels section (10px, letterSpacing).

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

3 header rows + data at 1Hz. Key columns parsed by csvParser.js:
```
Lcl Date, Lcl Time, Latitude, Longitude
AltInd (ft MSL baro), AltGPS (ft MSL GPS), AGL (ft — souvent null en vol)
IAS (kt), GndSpd, TRK (GPS track vrai), HDG (cap magnétique), MagVar
VSpd (fpm), Pitch, Roll, NormAc, LatAc
E1 RPM, OAT, E1 CHT1, E1 EGT1
```

**Important** : `AGL` est souvent null/0 en vol (G3X ne le publie pas toujours).
Utiliser `AltGPS` (ft MSL) pour les calculs d'altitude caméra.

**frame.bearing** : calculé dans csvParser → `TRK` (GPS vrai) si dispo, sinon `HDG + MagVar` (cap vrai corrigé). Toujours utiliser `frame.bearing` pour orienter la caméra, jamais `frame.hdg` brut.

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
- Props: `frames`, `currentFrame`, `is3D`, `isPlaying`, `speed`
- Fits bounds of loaded flight automatically
- Ghost trace: gray dashed #6b7280, 2px (future path)
- Played trace: 5px colored by flight phase
- Aircraft marker: `/icons/VL3.svg` via HTML `<img>` tag (NOT map.loadImage — SVG non supporté WebGL)
  - Marker inversé (`filter: invert(1)`) sur cartes sombres (Satellite/Dark)
  - Créé via `createAircraftMarker(isDark)` → `maplibregl.Marker({ element })`
- AIP panel: identical to LIVE minus traffic
- Basemaps: same 5 styles
- 2D/3D toggle button: centré en haut de la carte, dans ReplayPage.jsx (pas dans ReplayMap.jsx)

---

## ReplayMap — Architecture 3D Cockpit (CRITIQUE)

### Altitude caméra — calcul correct
```javascript
// AGL vrai = AltGPS MSL − élévation terrain DEM
const altGpsM   = frame.altGps * 0.3048          // ft → mètres MSL
const terrainM  = map.queryTerrainElevation([lon, lat]) ?? 0  // mètres MSL
const trueAglM  = altGpsM - terrainM             // vrai AGL en mètres
const aglM      = phase === 'GROUND' ? 4 : Math.max(20, trueAglM)
```

**JAMAIS** utiliser `frame.agl` directement (souvent null/0 en vol).
**JAMAIS** utiliser `AltInd` (baro QNH) pour la caméra → erreurs terrain.
`exaggeration: 1.0` OBLIGATOIRE — avec 1.5x le terrain visuel > terrain DEM → caméra dans le sol.

### Bearing caméra — lissage adaptatif
```javascript
// Détection virage : comparer 3 dernières frames
const isTurning = deltaLastFrames > 1.5°

// En croisière : buffer 8 frames, dead zone 3°, lerp 20%
// En virage    : buffer 3 frames, dead zone 0.5°, lerp 50%
```

### Zoom caméra
```javascript
function aglToZoom(aglM, offsetSlider = 12) {
  const z = Math.log2(1638400 / Math.max(2, aglM))
  return Math.max(8, Math.min(18, z + (offsetSlider - 12) * 0.5))
}
// Seuil 5% : ne change pas si variation < 5%
// Lerp 15% vers la cible
```

### Anti-snapback (CRITIQUE)
```javascript
// duration DOIT être < intervalle entre frames, sinon MapLibre rebondit
const frameInterval = 1000 / speed       // ms entre frames
const dur = Math.max(16, frameInterval * 0.75)
map.easeTo({ ..., duration: dur, easing: t => t })  // linéaire = pas de rebond
```

### Pre-caching tuiles terrain
Avant le replay 3D, survoler silencieusement 25 points clés via `map.jumpTo()` pour charger les tuiles DEM en cache. Déclenché 1.5s après activation 3D.

### Centre caméra (vue cockpit)
```javascript
// Centre MapLibre = point devant l'avion, pas la position de l'avion
const pitchRad = cockpitPitch * Math.PI / 180
const aheadKm  = Math.max(0.01, aglM * Math.tan(pitchRad) / 1000)
const center   = getAheadPoint(lon, lat, bearing, aheadKm)
// Géométrie : œil à altitude aglM, regarde vers le bas à angle (90°-pitch)
// → center est sur le terrain dans l'axe du cap
```

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
// Sandbox API key: sk_test_d74f45601570557f758c67a147ba32fe3181944c9241a2b9
```

---

## SliderRow / SliderTrack Component — RÈGLE CRITIQUE

**Ne JAMAIS définir ce composant à l'intérieur d'un autre composant.**
Le définir à l'intérieur cause un unmount/remount à chaque render → drag impossible.
**Toujours le déclarer en top-level**, avant le `export default function`.

```jsx
// ✅ CORRECT — top-level, avant export default
function SliderRow({ value, min = 0, max = 30, step = 1, color, onChange }) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div style={{ position: 'relative', height: 10, display: 'flex', alignItems: 'center' }}>
      <div style={{ position: 'absolute', width: '100%', height: 1, background: 'rgba(255,255,255,0.08)', borderRadius: 1 }} />
      <div style={{ position: 'absolute', width: `${pct}%`, height: 1, background: color, borderRadius: 1 }} />
      <div style={{ position: 'absolute', left: `calc(${pct}% - 4px)`, width: 8, height: 8, borderRadius: '50%', background: color, pointerEvents: 'none' }} />
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ position: 'absolute', width: '100%', opacity: 0, cursor: 'pointer', height: 10, margin: 0, background: 'transparent', WebkitAppearance: 'none', appearance: 'none' }} />
    </div>
  )
}

export default function AerotraceMap() { ... }
```

Utilisations :
- AIP layers (CTR/TMA/DANGER) : `min=0, max=30, step=1`
- Cockpit ALTITUDE : `min=8, max=16, step=0.5, color="#F5A623"`
- Cockpit ANGLE : `min=60, max=85, step=1, color="#22c55e"`
- Traffic altitude MIN/MAX : `min=0, max=ALT_MAX(35000), step=1000`

---

## AIP Layers — Toggle (CRITIQUE)

Le `onClick` pour toggle un layer AIP doit être sur le **div parent de la rangée**, pas sur le `<span>` label seul. Zone cliquable trop petite sinon.

```jsx
// ✅ CORRECT
<div onClick={() => toggleLayer(layer.id)} style={{ ..., cursor: 'pointer' }}>
  <span style={{ ... }}>{layer.label}</span>
</div>

// ❌ INCORRECT — zone cliquable trop petite
<div style={{ ... }}>
  <span onClick={() => toggleLayer(layer.id)} style={{ cursor: 'pointer' }}>{layer.label}</span>
</div>
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

## Dev Setup

```bash
# Terminal 1 — SafeSky proxy
cd dashboard/proxy && node server.js   # port 3001

# Terminal 2 — Vite dev server
cd dashboard && npm run dev             # port 5173
```

Projet sur **iCloud Apple** :
```
/Users/c.erkens/Library/Mobile Documents/com~apple~CloudDocs/
00 - A.DVP DIGITAL FLIGHT RECORDER/CODAGE/aerotrace/dashboard
```

Workflow fichiers : Claude génère → Christophe télécharge → `cp` dans terminal.

Git base saine : commit `facef2e`
**Ne jamais modifier ReplayMap.jsx sans upload préalable du fichier existant.**

---

## Do Not

- ❌ Never use gray/low-opacity text on dark backgrounds → use #ffffff
- ❌ Never call SafeSky directly from browser → always via proxy
- ❌ Never use Mapbox GL JS → MapLibre only
- ❌ Never use integer filters for OpenAIP → use string type values
- ❌ Never commit `.env.local` or `serviceAccountKey.json`
- ❌ Never delete Firestore documents → use `archived: true`
- ❌ Never use class components → functional only
- ❌ Never use `map.loadImage()` with SVG files → WebGL ne supporte pas SVG
- ❌ Never use terrain `exaggeration > 1.0` → caméra passe dans le sol
- ❌ Never use `frame.agl` directement → souvent null/0 en vol G3X
- ❌ Never use `easeTo(duration)` > frameInterval → snapback caméra
- ❌ Never use `frame.hdg` brut pour la caméra → toujours `frame.bearing`
- ❌ Never define SliderRow/SliderTrack inside a component → drag broken
- ❌ Never put onClick only on label span for layer toggle → use parent div