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

## Language — MANDATORY

**All UI text must be in English UK.** No French anywhere in user-facing strings — web dashboard pages, labels, buttons, status messages, and T-RGB cockpit display. British spellings apply (e.g. "Licence", "Colour").

## Critical conventions (read copilot-instructions.md before changing any of these)

These are the failure modes that have already cost time. The detailed rationale is in `../.github/copilot-instructions.md`; the short version:

**Theme split.** Pages are LIGHT (`#f0f2f8` bg, `#0a0e1e` text, monospace). Maps (`AerotraceMap`, `ReplayMap`) are DARK (`#050814` bg, `#ffffff` text). Never use gray/low-opacity text on dark backgrounds — pure `#ffffff` only. Accent is `#F5A623` everywhere.

**SliderRow / SliderTrack must be top-level.** Defining a slider component inside another component remounts it every render and breaks the drag interaction. Declare these *outside* and above the page/component that uses them.

**AIP layer toggle clickable area.** Put `onClick` on the row's parent `<div>`, not on the inner `<span>` label.

**OpenAIP filters use string types**, not integers: `['==', ['get', 'type'], 'ctr']`, `['in', ['get', 'type'], ['literal', ['tma','cta']]]`. Airport key is `icao_code`, not `icaoCode`.

**3D camera math (ReplayMap) — hybrid approach.** Use `calculateCameraOptionsFromCameraLngLatAltRotation([lon,lat], altMSL_m, bearing, pitch, 0)` (MapLibre v5 native API) for the geometrically correct `center` look-at point, but **always override its `zoom`** with `Math.log2(1638400 / aglM) + zoomOffset`. Reason: the native API computes zoom from camera-to-center *distance* (≈ 3.24×AGL at pitch=72°), which places terrain 3.25× too small visually. AGL-based zoom matches pilot perception.

- Never use `frame.agl` (often null/0 in G3X). Never use `AltInd` (baro). Always `AltGPS_ft × 0.3048 − queryTerrainElevation()`.
- `smoothAgl.current` must stay `null` until `queryTerrainElevation` returns a non-null value — initialising from estimated altitude causes a snap when DEM tiles first load.
- Terrain `exaggeration` must stay at `1.0` or the camera goes through the ground.
- `easeTo` duration must be `< frameInterval` (use `frameInterval * 0.85` with linear easing) or MapLibre snaps back.
- Pre-cache 25 DEM tiles via silent `jumpTo` (zoom=12) before starting 3D replay.
- `zoomOffset` slider: default `1.0`, range `−2` (wide) to `+3` (close). Resetting it clears `prevZoom.current` to avoid a zoom snap.

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

<!-- Ajouté le 2026-09-19 depuis 01 - Documentation/CLAUDE-append.md (design handoff copié dans 01 - Documentation/design_handoff_airki/). Décision prise en autonomie : panneaux sombres = encre #141414 des guidelines (l'ancien bleu-nuit #0A0E1E est abandonné) — à confirmer par Christophe. -->


## Design system — AirKi

Read this before writing any UI. The full spec is `design_handoff_airki/README.md`; the
authoritative visual reference is `design_handoff_airki/AirKi Brand Guidelines.dc.html`
(open it in a browser).

The bundled HTML files are DESIGN REFERENCES, not production code. Their markup is
inline-styled single-file prototypes. Read them for values and layout, then build real
components in this codebase's own framework and patterns.

### Product
AirKi: connected flight recorder for light aviation and ultralight aircraft.
- AirKi Core (designator AKT) — embedded unit, ESP32-S3 + SIM7600 LTE/GNSS, 60 mm sealed box,
  4 Hz recording in Garmin G3X-compatible format, SafeSky beacon, traffic in, WiFi ground transfer, OTA.
- AirKi View (designator AKV) — cockpit display, Waveshare ESP32-S3 AMOLED touch 2.41", 600x450 landscape, BLE to the unit.
- AirKi Dashboard — Firebase web app: live fleet map, Loop (flight replay), logbook with instructor
  validation, aircraft/pilot management, fleet health. Multi-club; roles admin / instructor / pilot.

### Non-negotiable brand rules
1. The name is always written **AirKi** — capital A, capital K, lowercase i.
   NEVER AIRKI, AirKI, AIRKi, Air-Ki. In German "KI" reads as artificial intelligence.
   Never apply `text-transform: uppercase` to any element that can contain the brand name
   (nav, eyebrows, buttons, table headers, tooltips, page titles, meta tags).
2. No gradients, anywhere.
3. No navy + sky blue.
4. Amber `#F5A623` is never a text colour and never colours the wordmark.
5. Fonts are Instrument Sans (verbal) and Geist Mono (all figures and technical labels).
   Never substitute Inter, Roboto, Poppins, Montserrat, Futura.
6. All figures — altitudes, speeds, times, Hobbs, serials, registrations, table numerics —
   are Geist Mono, tabular.
7. Text on dark panels is white or `#9A9A94`. No muted/alpha type on colour.
8. No shadows. Borders are always 1 px.
9. AKT / AKV are technical designators: labels, serials, firmware, fleet tables.
   Customer-facing copy says AirKi Core and AirKi View.
10. Loop is text only, Semibold, ink — never with the monogram, never coloured.

### Tokens

```css
:root {
  --ink:        #141414; /* text, marks, dark panels — never pure black */
  --paper:      #F4F2ED; /* app background — warm, never clinical white */
  --card:       #FFFFFF;
  --graphite:   #4A4A46; /* secondary text */
  --etch:       #8D9096; /* muted text on ink, laser etching */
  --rule:       #DDD9D2; /* borders on paper */
  --rule-dark:  #2C2C2C; /* borders on ink */
  --muted-dark: #9A9A94; /* labels/units on ink */
  --amber:      #F5A623; /* single accent; also caution status */
  --ok:         #22C55E; /* status only */
  --info:       #60A5FA; /* status only */
}
```

Usage proportions: ink 46 %, paper 34 %, graphite 8 %, etch 6 %, amber 6 %.

Type scale (Instrument Sans): display 700, 32-56px, -0.035em · heading 600, 18-28px, -0.02em ·
body 400, 14-17px, lh 1.5 · caption/UI 500, 11-13px.
Data (Geist Mono): value 500, 28-72px, -0.04em · unit label 500, 10px, uppercase, 0.08em, etch/muted grey.

Spacing: 4 6 8 10 12 14 16 18 22 24 28 32 40 48 72 96.
Radius: 3-4 (chips, buttons) · 6 (cards, panels) · 12-16 (enclosure renders) · 999 (pill).

### Logo component
One SVG path on a 100x100 viewBox, `fill-rule="evenodd"`. The second subpath is the counter.

```
M10 92 L38 8 L62 8 L90 92 L70 92 L63.3 74 L36.7 74 L30 92 Z M50 32 L40 62 L60 62 Z
```

Two treatments, and only these two:
- **two-colour** — the evenodd path in ink (or white in reverse), plus a separate amber path
  `M50 32 L40 62 L60 62 Z` filling the counter.
- **one-colour** — the evenodd path alone, counter open. Required for etching, embroidery,
  amber grounds, below 6 mm, and any monochrome use.

Build it as `<AirKiMark variant="duo" | "mono" color={...} size={...} />`. Minimum 16 px on screen.
Wordmark: Instrument Sans Bold, letter-spacing -0.04em. Lockup gap = half the A's apex width;
baseline "Not alone in the sky" at 19.5 % of wordmark size, Medium; clear space = 1 apex width.
Drop the baseline below 60 px.

### Screens already designed
See README.md for full measurements.
- **Dashboard / Live** — 180 px sidebar (lockup, nav Live/Loop/Logbook/Fleet/Admin, club + ICAO
  footer) + content: title row with "Open Loop" primary, three ink metric cards
  (`{registration} · {metric unit}` label, Geist Mono 30px value, coloured status dot), and a
  flight table (FLIGHT / PILOT / BLOCK; `ICAO → ICAO`, pilot name, `HH:MM`).
- **AirKi View home** — 600x450 ink panel, two-colour monogram, "AirKi View", GPS/LTE/TRAFFIC
  status dots, UTC bottom-left, registration bottom-right. Nothing below 13 px on the real panel.
- **Product page / Core** — nav bar, two-column hero, eyebrow + 36 px headline + body +
  "Book a demo" primary and "Technical sheet" link, unit render on the right. No prices anywhere.

### What is NOT designed — ask before inventing
Empty, loading and error states. The View traffic radar, SD flight list, pilot code entry and
locked club mode (the radar exists in firmware — restyle it, don't redesign it). Icon set: none
chosen; pick one open, non-rounded, 1.5 px-stroke family — no rounded geometric sets. Pricing.
Dashboard panel colour: the guidelines use ink #141414; an earlier product brief said #0A0E1E —
confirm with the user before using blue-black.
- 2026-09-21 08h : dashboard DÉPLOYÉ EN PROD (hosting) avec la coquille AirKi + Fleet wifiKnown (« go publie » Christophe). Pages Live/Loop/Logbook/Fleet/Admin encore à restyler.
- 2026-09-21 : Fleet → fiche boîtier : liste des réseaux connus avec Modifier (pré-remplit SSID, nouveau mot de passe) et Supprimer (wifiForget + wifiForgetSeq au Save, ATC ≥214). Déployé prod.
- 2026-09-21 soir : LOT 01 « assainir » (réflexion https://claude.ai/artifact/NRLMhFVh8BAxY414S3w233) — anglais UK Logbook/modale/carte, en-tête club via useClub, flights en onSnapshot, suppression = `archived: true` (plus de deleteDoc ; onFlightDeleted ne nettoie donc plus Storage), dates « 21 Sep 2026 · 14:32 UTC » (logbookUtils.formatDate/formatDateTime), `isStudent` règle unique (licence absente = breveté), `needsAssignment` + règle PROPRIÉTAIRE (pilote = ownerPilotId, pas d'instructeur, modale pré-remplie ; côté cloud normalizeFlight auto-valide, autoAssigned 'owner'), tris Pilots/Instructors indépendants, IMPORT CSV déplacé de Loop vers Logbook (validated:false, source 'dashboard-import', createdAt + uploadedAt), écran « Not allowed » au lieu de redirection muette, /en-vol → /in-flight (redirection), /diag retiré, « Member » → « Pilot », LoginPage AirKi (encre, lockup 64 + baseline, bouton blanc), Live : pastilles Loading fleet / Traffic unavailable / No aircraft in flight (hook local useTrafficPoll dans AerotraceMap ; useSafeSky.js n'est plus utilisé). Déployé sur le canal de prévisualisation « airki » seulement.
- 2026-09-21 nuit : LOGBOOK = SEULE LISTE DE VOLS, LOOP = LECTEUR (décision Christophe) — nav Live · (In flight) · Logbook · Fleet · Admin · Dev ; « Loop » retiré du menu (nom gardé : lecteur /replay/:id, bouton « Back to logbook », états vides). Logbook ouvert à TOUS les rôles : pilote (user) = onglet unique « My flights » (ses vols, lecture seule, « Open Loop ») ; instructeur/admin = « My flights » en premier si la fiche est reliée. Liaison compte ↔ fiche : `findMyPilot` (p.uid === user.uid, sinon e-mail). ⚠️ Cloisonnement = affichage seulement (règles Firestore : lecture des vols pour tout compte connecté).
- CODES D'INVITATION PILOTE : fonctions `createPilotInvite` (admin, fiche de son club, 8 car. ABCD-2345 sans 0/O/1/I, 14 j, usage unique, révoque les précédents) et `redeemInvite` (transaction : users/{uid}.clubId/role/pilotId + pilots/{id}.uid/accountEmail ; ne rétrograde jamais admin/super_admin ; role instructor si fiche isInstructor). Collection `inviteCodes` sans règle → fermée aux navigateurs. UI : Admin → Pilots (« INVITE CODE » / « NEW CODE », COPY, statut LINKED / NOT LINKED), `components/auth/RedeemInvite.jsx` sur l'écran Access pending et dans le Logbook non relié. Permet Apple / tout fournisseur sans dépendre de l'e-mail.
- 2026-09-21 22h : prévisualisation (lot 01 + Logbook pilotes + Loop lecteur + codes d'invitation) POUSSÉE EN PROD sur demande (« pousse »), non testée navigateur.
- 2026-09-21 nuit : LOT 02 « bibliothèque AirKi » — `src/components/ui/` : tokens.js (T + labelStyle/valueStyle/headingStyle/monoStyle), styles.js (focus ambre clavier, keyframes Skeleton, largeur Drawer), Button (primary/secondary/ghost/danger + confirm 2 temps, onInk), MetricCard, StatusDot (ok/caution/info/off, JAMAIS de rouge), DataTable, Tabs, Drawer (portail, Échap, focus piégé, `closeOnOverlay`), EmptyState, Banner, Skeleton, Icon (20 icônes, trait 1,5, sans arrondis), index.js. Adoptée par Logbook (+ FlightAssignModal en Drawer), Fleet (fiche boîtier en Drawer, MetricCards, DataTable), Dev, Admin (formulaires en Drawer, DataTable, Input/Select/Chip LOCAUX à factoriser), SelectClub (encre + lockup), In flight (kt au lieu de km/h), cadre de Loop, écrans d'accès. Carte/SixPack/courbes NON touchés. Loop affiche encore km/h (DataStrip) ; couleurs des phases de vol changées (CRITICAL ink, MANEUVER info). Manques bibliothèque : Input, Select, Chip, Segmented, icône plus, rowStyle DataTable, initialFocus Drawer. Fiche pilote : licence absente = 'pilot' à l'édition (plus d'écriture silencieuse de 'student'). Lint : 22 erreurs, surtout set-state-in-effect et composants déclarés dans le rendu, antérieures. Déployé prévisualisation seulement.
- 2026-09-21 nuit : page In flight en 3 COLONNES (In flight · On ground · Unknown) — cartes encre avec ALT/GS/HDG live pour les avions en vol (LTE lost dans In flight, point ambre), cartes blanches compactes au sol / inconnus, compteur 40 px par colonne. Plus de Tabs ni de StatBar. Prévisualisation.
- 2026-09-21 nuit : Admin → recherche sur Pilots (nom, trigramme, e-mails, licence, FI), Aircraft (immat, indicatif, type, hex, base, OWNER + nom du propriétaire, CLUB, archived), Access (e-mail, nom, rôle ; membres + invitations). `matches()` insensible casse/accents, mots combinés ; Échap vide ; compteur n / total ; état vide « No … matches » + Clear search.
- 2026-09-21 nuit : Admin → PURGE (suppression définitive) des fiches ARCHIVÉES, pilotes et avions : bouton Purge par ligne + « Purge archived (n) » dans la barre, confirmation « Delete forever? ». Garde-fou : une fiche citée par des vols non archivés du club (pilotId/instructorId, aircraftIdent = immat ou indicatif) est gardée, message « Kept to preserve the logbook ». Photo Storage de l'avion supprimée avec la fiche. Pilotes archivés désormais affichés grisés + ARCHIVED + Restore (avant : réapparaissaient comme actifs au rechargement). Compteurs d'onglets = actifs ; sélecteur propriétaire sans pilotes archivés.
- 2026-09-21 nuit : VOLS ARCHIVÉS (règle Christophe : archive = trace gardée et lisible ; purge = vol + traces supprimés, message clair). Logbook → onglet « Archived » (admin/super_admin) : Open Loop, Restore, Purge par ligne et « Purge all archived (n) », confirmation par Banner explicite (« The flight record and its recordings (flight track CSV and LTE log) will be deleted permanently… »). Loop ouvre un vol archivé avec une Banner « Archived flight ». Fonction `onFlightDeleted` : n'efface plus un fichier encore référencé par une autre fiche (csvStoragePath, csvLteStoragePath ou même flight_id) — garde-fou de l'incident du 19/09 (trace EBBY→EDRA perdue).
- 2026-09-21 nuit : Live → bandeau FLEET (`components/map/FleetStrip.jsx`, source useFleet = même que In flight) : « ● n in flight REG · REG ○ n on ground ● n not reporting » ; clic immat = centre la carte (LivePage passe un flyTo neuf), clic « in flight » = page In flight, survol = « x club · y owner » ; LTE lost = point ambre. Supprimé : pastilles « Loading fleet » / « No aircraft in flight » de la carte (calcul par trafic de la zone visible = faux). Reste sur la carte : « Traffic unavailable, retrying… » (top 64 sous le bandeau).
- 2026-09-21 nuit : `components/aircraft/AircraftPhoto.jsx` (photo fiche → photo web auto → type OACI ; onInk) partagé Admin + In flight ; In flight : vignette 64×48 (en vol, encre) / 56×42 (au sol, inconnus) à gauche de l'immat ; libellés de colonne LIVE / PARKED / NO RECENT SIGNAL (plus de « LIVE » sur Unknown).
- 2026-09-21 nuit : RECADRAGE photo avion — fiche Admin → Aircraft : `PhotoFramer` (cadre 4:3 192×144, glisser = point visé, curseur zoom 1–3, flèches/± au clavier, Reset) ; champs aircraft `photoZoom`, `photoX`, `photoY` enregistrés ; remis à 1/50/50 quand la photo change. `components/aircraft/photoFrame.js` (style object-position + scale) appliqué par AircraftPhoto (Admin, In flight) aux photos de la fiche.
- 2026-09-21 23h : TOUT POUSSÉ EN PROD (« committe pousse ») — lot 02, In flight colonnes + photos, recherche/purge Admin, vols archivés, bandeau FLEET, recadrage photo. Dépôts GitHub à jour (aerotrace 9d3982e, at-core 523ccc7, at-core-trgb e87a2ba).
- 2026-09-21 23h : favicons AirKi complets (favicon.ico 16/32/48, favicon-32.png, apple-touch-icon 180, icon-192/512, site.webmanifest, theme-color #141414) générés depuis le tracé officiel du monogramme (A blanc, contreforme ambre, fond encre). Avant : /favicon.ico renvoyait index.html. Prod.
- 2026-09-21 23h : AirKiLockup ALIGNEMENT OPTIQUE — monogramme = hauteur des capitales (SVG 0,857 × corps, marginTop 0,0714 em, alignItems flex-start, gap 0,11 em) au lieu d'un monogramme de la taille du corps centré sur mot + baseline (il descendait sous la ligne). AirKiMark duo : ambre dessous (+ contour 2,5) puis A par-dessus → plus de liseré sombre. LoginPage : bouton 48 px à la largeur exacte du lockup, groupe remonté de 6 vh. Prévisualisation.
- 2026-09-22 : SYNCHRO CLAUDE DESIGN — projet design system « AirKi Dashboard » https://claude.ai/design/p/9c2df9a6-1c38-4466-b6a1-f1e6119e58c9 (12 composants de src/components/ui, aperçus rédigés et notés bons, note de conventions pour l'agent). Config et notes : .design-sync/ (config.json, NOTES.md, conventions.md, previews/). Re-synchro : `/design-sync`. Jetons + polices sortis dans src/styles/airki-tokens.css (source unique, importée par index.css). Les props des composants sont décrites À LA MAIN dans .design-sync/config.json → dtsPropsFor : à mettre à jour quand une prop change.
- 2026-09-22 : PAGE LIVE d'après Claude Design (export `01 - Documentation/design_handoff_airki/AirKi Live page/Live.dc.html`) — LivePage = carte + panneau `LiveInFlightPanel` 320 px à droite (repliable en rail 44 px, mémorisé `ak_live_panel`), UN seul useFleet (bandeau + panneau ; useFleet expose `updatedAt`). `FleetStrip` sans position propre (passé en `topCenter` à la carte), `fleetPos.js` (posOf), `hooks/useOwnerNames.js` (partagé avec In flight). AerotraceMap : panneau LAYERS encre 212 px (interrupteurs, TRAMES CTR/TMA/Danger CONSERVÉES avec leurs couleurs — demande Christophe, types d'aérodromes, bande trafic 2 poignées 0→FL195+, choix du fond MAP conservé), LÉGENDE repliable, bannière « Traffic unavailable » avec Retry now, marqueurs : flotte = avion blanc/encre dans anneau ambre 40 px, SafeSky = bleu info, radio = etch (icônes par type colorées par masque CSS), étiquettes mono sans cadre, popup kt (avant km/h). Corrigé : fond persistant appliqué dès le chargement (avant : toujours Light) ; couches masquées/trames réappliquées après changement de fond ; carte redimensionnée quand le panneau se replie. Prévisualisation seulement.
- 2026-09-22 00h : LOCKUP AirKi REFAIT (correction Christophe) — le grand A du monogramme (ambre dans la contreforme) EST la 1re lettre, suivi de « irKi » plus petit, collé, même ligne de base (A ≈ 1,55 × hauteur de capitales, écart 8 % du A). `size` = hauteur visible du A. Avant : monogramme + « AirKi » complet (se lisait « A AirKi »). Login : size 76. Trafic radio sur Live : encre sur fond clair / blanc sur fond sombre, 34 px (gris trop pâle). À resynchroniser dans Claude Design (/design-sync). Prévisualisation.
- 2026-09-22 00h : MENU DE GAUCHE d'après Claude Design — icônes 18 px (Live map, In flight plane, Logbook list, Fleet archive, Admin settings, Dev search), lignes pleine largeur, active = fond #1E1E1E + filet ambre 2 px + blanc, inactive #9A9A94 (blanc au survol). Lockup calé au calcul (pied du A = ligne de base de « irKi », métriques Instrument Sans vérifiées). Live + lockup + menu POUSSÉS EN PROD.
- 2026-09-22 nuit (autonomie, PRÉVISUALISATION seulement, rien en prod) : LOOP — panneaux carte encre comme Live (curseurs DS, puces de fond, bouton COCKPIT/FREE sans emoji), couleurs de phase alignées sur la frise (plus de rouge/orange), aérodromes en anglais, GS en kt (bandeau : unités dans les libellés ; courbes ; fiche d'attribution) — le cadran ASI du six-pack reste en km/h (décision 10/08). BIBLIOTHÈQUE : Field, Input, Select, Chip, Toggle + `fieldStyle()` (tokens.js), utilisés par Admin/Fleet/Logbook ; synchro Claude Design 17 composants. Titres de page unifiés heading 28 (In flight, Logbook, Fleet, Admin) ; durées In flight en HH:MM. Écran AKV v306 (lockup accueil en un mot) publié ws241dev seulement.
- ⚠️ SÉCURITÉ (constat 22/09, non corrigé) : /deviceConfig (contient wifiPass) et /flights sont lisibles par TOUT compte connecté, y compris un compte ANONYME que n'importe qui peut créer avec la clé API publique (les boîtiers s'authentifient en anonyme). Une règle « boîtier seulement » ne protège donc pas. Correction réelle = secret par boîtier (fonction cloud qui délivre la config WiFi contre ce secret) + firmware. Cloisonnement pilote (vols) = règles par clubId/pilotId + requêtes Logbook filtrées côté client. À décider avec Christophe.
- 2026-09-22 07h45 : POUSSÉ EN PROD (« pousse en prod ») — Loop (carte AirKi, kt), bibliothèque Field/Input/Select/Chip/Toggle, titres unifiés, In flight HH:MM, Logbook (Assign en premier, 11 colonnes).
- 2026-09-22 08h : IN FLIGHT d'après Claude Design (export `design_handoff_airki/AirKi Dashboard-2/templates/in-flight/InFlight.dc.html`) — en-tête (méta FLEET OF n · AUTO-REFRESH 5 S · UPDATED hh:mm UTC, boutons Refresh / Open Live map), bannière si erreur ou données > 40 s, 4 MetricCard (IN FLIGHT, ON GROUND, NO SIGNAL, LONGEST AIRBORNE), sections Airborne (cartes : photo 72×54, CLUB/OWNER + nom, IN FLIGHT · LIVE / LTE LOST · n MIN, ALT FT / GS KT / HDG 22 px, source « SAFESKY NETWORK · n S AGO » ou « AIRKI CORE ONLY · LAST … AGO », pilote + AIRBORNE hh:mm, Show on map), On the ground (dernier vol lu dans /flights : LAST FLIGHT TODAY · hh:mm), Silent boxes (NO DATA SINCE …). useFleet expose `refresh()` et `liveData.fixTs`. Prévisualisation.
- 2026-09-22 08h05 : POUSSÉ EN PROD — In flight (Claude Design, cartes empilées, dernier signal /devices), libellés AKcore / AKview.
- 2026-09-22 09h : LOGBOOK d'après Claude Design (export `design_handoff_airki/AirKi Dashboard-3/templates/logbook/Logbook.dc.html`) — durées HH:MM PARTOUT (formatDuration), en-tête + bouton « Import G3X CSV », MetricCard avec statut, onglet All flights = FILE à attribuer (bandeau encre TO ASSIGN · OLDEST · HOURS UNCREDITED · ASSIGNED AUTOMATICALLY, groupes jour → avion, plus ancien d'abord, 20 à la fois, « Assign next flight » / « Review queue ») + tableau groupable (DAY/AIRCRAFT/PILOT/FLAT) et triable, filtres Field/Select, colonnes empilées ; tiroir d'attribution : résumé du vol, bascules Student/Licensed (lecture profil) et On board/On ground, « Save & next flight », suggestion du dernier pilote (même avion, même jour), NEXT IN QUEUE ; My flights avec statuts ; carte « Link your account » ; « Add a flight by hand » en bas. NON construits (nouveaux, accord requis) : attribution groupée « Assign these N », export CSV. Prévisualisation.
- 2026-09-22 09h15 : Logbook — ATTRIBUTION GROUPÉE (demande Christophe) : cases à cocher (vol, groupe avion, jour, en-tête du tableau pour les vols à attribuer), barre encre collante « N SELECTED · hh:mm · Clear · Assign N flights », tiroir BulkAssignDrawer (un pilote + instructeur/présence si élève ; chaque vol garde son avion, avion à choisir pour ceux qui n'en ont pas ; règles propriétaire / licence vol par vol ; writeBatch tout ou rien). Prévisualisation.
- 2026-09-22 09h30 : listes de choix TRIÉES alphabétiquement (utils/sortOptions.js : Intl.Collator, casse/accents ignorés, entrée vide en tête) — pilotes, instructeurs, avions, types de vol (Logbook, tiroirs d'attribution unitaire/groupée, propriétaire Admin), types OACI (Admin, par code), clubs (SelectClub, par code).
- 2026-09-22 10h : Logbook — cartes Pilots / Instructors / Aircraft dépliées par ANNÉE → MOIS → JOUR (FlightsByPeriod : lignes dépliables avec totaux, année + mois récents ouverts, un tableau par jour). DURÉES INVRAISEMBLABLES (> 12 h, isDurationSuspect dans logbookUtils) exclues de TOUS les totaux (sumDuration, tris Hours, répartition par type, heures du mois Fleet) et signalées : point ambre + infobulle sur la durée, « n DURATIONS TO CHECK » sur la carte, « n TO CHECK » dans les totaux de période. Cas connu : 7 vols OOI43 (ATC19019/19014/20598/19039/20043/20627/19065.csv, 119 à 719 h). Prévisualisation.
- 2026-09-22 10h55 : POUSSÉ EN PROD — Logbook Claude Design (file à attribuer, Save & next, multisélection + attribution groupée, tableau groupable, HH:MM), listes triées, cartes par année/mois/jour lisibles + colonne ROUTE, durées > 12 h exclues des totaux et signalées.
