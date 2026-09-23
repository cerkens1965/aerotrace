import { useEffect, useRef, useState, useCallback } from 'react'
import { fetchWebPhoto } from '../../lib/webphoto'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../../firebase/config'
import { useClub } from '../../contexts/ClubContext'
import { T, labelStyle, monoStyle, Banner, Icon } from '../ui'

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY
const OPENAIP_KEY = import.meta.env.VITE_OPENAIP_KEY
const CENTER = { lat: 50.6083, lon: 4.4650 } // EBBY
const ALT_MAX = 19500   // (22/09) bande trafic 0 → FL195 ; poignée haute en butée = pas de plafond (FL195+)

// (22/09, Claude Design « Live ») Sémantique couleur carte :
//   FLOTTE du club (AirKi Core, club OU owner) = avion BLANC (encre sur fond clair) dans un ANNEAU AMBRE 40 px
//   PARTAGEURS SafeSky (app / balises ADS-L)    = BLEU info #60A5FA, 34 px
//   TRAFIC RADIO (ADS-B / Mode-S / FLARM, capté) = ENCRE #141414 sur fond clair, blanc sur fond sombre, 34 px
// Les icônes par type (public/icons/*.svg, noires) sont colorées par MASQUE CSS : couleur exacte, sans filtre.
const SAFESKY_CLR = T.info
const RADIO_SRC   = new Set(['ADS-B', 'ADS-BI', 'ADSB', 'MODE-S', 'MODE-C', 'MLAT', 'FLARM', 'OGN'])
const isDarkMap   = (id) => id === 'dataviz-dark' || id === 'satellite'

// Icône par type d'aéronef — reprend le set + la sémantique de l'écran ATV radar
// (firmware getAircraftIcon / safeSkyUDPToIcon). SafeSky REST donne le TYPE dans
// `beacon_type` (STRING : JET, MOTORPLANE, HELICOPTER, UAV, GLIDER…) ; on le mappe
// vers les mêmes SVG que le radar (public/icons/, monochromes recolorables au filter).
const BEACON_ICON = {
  GLIDER: 'glider', MOTOR_GLIDER: 'glider', SAILPLANE: 'glider',
  TOW_PLANE: 'light_aircraft', DROP_PLANE: 'light_aircraft',
  HELICOPTER: 'helicopter', ROTORCRAFT: 'helicopter',
  PARACHUTE: 'parachute', SKYDIVER: 'parachute',
  HANG_GLIDER: 'hand_glider', HANGGLIDER: 'hand_glider',
  PARA_GLIDER: 'para_glider', PARAGLIDER: 'para_glider',
  MOTORPLANE: 'light_aircraft', POWERED_AIRCRAFT: 'light_aircraft', ULTRALIGHT: 'light_aircraft',
  JET: 'heavy_aircraft',
  BALLOON: 'ballon', AIRSHIP: 'airship',
  UAV: 'uav', DRONE: 'uav',
  GYROCOPTER: 'gyrocopter',
  STATIC_OBJECT: 'dot',
  UNKNOWN: 'aircraft',
}
const iconForBeacon = (bt) => BEACON_ICON[(bt || '').toUpperCase()] || 'aircraft'

// (2026-08-31) Photo en tête de popup — v = {url,credit,link} (fiche club ou planespotters),
// false/null/undefined = rien. Crédit photographe cliquable (condition planespotters).
const popupPhotoHtml = (v) => (v && v.url) ? `
  <div style="margin:-4px -4px 6px;">
    <img src="${v.url}" alt="" style="display:block;width:100%;max-height:150px;object-fit:cover;border-radius:4px;"/>
    ${v.credit ? `<a href="${v.link || '#'}" target="_blank" rel="noreferrer" style="font-family:monospace;font-size:9px;color:#888;text-decoration:none;">© ${v.credit} · ${v.site || 'planespotters.net'}</a>` : ''}
  </div>` : ''

const BASEMAPS = [
  { id: 'dataviz-light', label: 'Light' },
  { id: 'dataviz-dark',  label: 'Dark' },
  { id: 'outdoor-v2',    label: 'Topo' },
  { id: 'satellite',     label: 'Satellite' },
  { id: 'basic-v2',      label: 'Basic' },
]

const AIRPORT_TYPES = [
  { id: 'fixed', label: 'Aerodromes · ULM · military' },
  { id: 'heli',  label: 'Helipads' },
  { id: 'sea',   label: 'Seaplane bases' },
]

const LAYERS = [
  { id: 'ctr',      label: 'CTR',          color: '#dc3232', rgb: '220,50,50',  hasSlider: true,  hasAltSlider: false },
  { id: 'tma',      label: 'TMA / CTA',  color: '#1e64dc', rgb: '30,100,220', hasSlider: true,  hasAltSlider: false },
  { id: 'danger',   label: 'Danger areas',   color: '#ff8c00', rgb: '255,140,0',  hasSlider: true,  hasAltSlider: false },
  { id: 'airports', label: 'Airports', color: '#4a7ab5', rgb: '74,122,181', hasSlider: false, hasAltSlider: false },
  { id: 'traffic',  label: 'Traffic',  color: '#00cc66', rgb: '0,204,102',  hasSlider: false, hasAltSlider: true  },
]

const LAYER_IDS = {
  ctr:      ['airspace-ctr-fill', 'airspace-ctr-line'],
  tma:      ['airspace-tma-fill', 'airspace-tma-line'],
  danger:   ['airspace-danger-fill', 'airspace-danger-line'],
  airports: ['airports', 'airports-labels'],
}

const FILL_COLORS = {
  ctr:    (o) => `rgba(220,50,50,${o})`,
  tma:    (o) => `rgba(30,100,220,${o})`,
  danger: (o) => `rgba(255,140,0,${o})`,
}

function formatAlt(ft) {
  if (ft <= 0) return '0'
  if (ft >= ALT_MAX) return 'FL195+'
  return `FL${String(Math.round(ft / 100)).padStart(3, '0')}`
}

function getAirportFilter(active) {
  if (!active.length) return ['==', 'type', 'NONE']
  const parts = []
  if (active.includes('fixed')) parts.push(['in', ['get', 'type'], ['literal', ['apt', 'af_civil', 'ad_mil', 'light_aircraft']]])
  if (active.includes('heli'))  parts.push(['==', ['get', 'type'], 'heli_civil'])
  if (active.includes('sea'))   parts.push(['==', ['get', 'type'], 'af_water'])
  return parts.length === 1 ? parts[0] : ['any', ...parts]
}

// (2026-08-17, demande Christophe) Clic dans une zone (hors icône avion) → popup des espaces
// aériens EMPILÉS sous le curseur (CTR + étages TMA + zones D/R/P), avec nom, classe et
// plancher→plafond. Tolérant aux variations de schéma OpenAIP (limites sous plusieurs formes).
const AIRSPACE_QUERY_LAYERS = ['airspace-ctr-fill', 'airspace-tma-fill', 'airspace-danger-fill']
const ICAO_CLASS = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
function fmtAirspaceLimit(p, which) {
  const v = p[`${which}_limit_value`] ?? p[`${which}LimitValue`]
  const u = p[`${which}_limit_unit`]  ?? p[`${which}LimitUnit`]
  const r = p[`${which}_limit_reference`] ?? p[`${which}LimitReference`]
  if (v != null) {
    const unit = String(u ?? 'ft').toUpperCase() === 'FL' || Number(u) === 6 ? 'FL' : 'ft'
    if (unit === 'FL') return `FL${v}`
    const ref = r != null ? ` ${String(r).toUpperCase() === 'MSL' || Number(r) === 1 ? 'AMSL' : (String(r).toUpperCase() === 'GND' || Number(r) === 0 ? 'AGL' : String(r))}` : ''
    return `${v} ${unit}${ref}`
  }
  const raw = p[`${which}_limit`] ?? p[`${which}Limit`]
  if (raw == null) return '?'
  try { const j = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (j && j.value != null) return fmtAirspaceLimit({ [`${which}_limit_value`]: j.value, [`${which}_limit_unit`]: j.unit, [`${which}_limit_reference`]: j.referenceDatum ?? j.reference }, which) } catch { /* brut */ }
  return String(raw)
}
function airspaceItems(feats) {
  const seen = new Set(); const items = []
  for (const f of feats) {
    const p = f.properties || {}
    const key = `${p.name}|${p.type}`
    if (seen.has(key)) continue
    seen.add(key)
    const typ = String(p.type || '').toUpperCase()
    items.push({
      name: p.name || '?',
      typ,
      cls: p.icao_class != null && ICAO_CLASS[Number(p.icao_class)] ? ICAO_CLASS[Number(p.icao_class)] : null,
      lo: fmtAirspaceLimit(p, 'lower'),
      up: fmtAirspaceLimit(p, 'upper'),
      color: typ === 'CTR' ? '#dc3232' : (['TMA', 'CTA'].includes(typ) ? '#1e64dc' : '#ff8c00'),
    })
  }
  return items
}

function addOpenAIPLayers(map, activeAirportTypes, dark = false) {
  if (map.getSource('openaip')) return
  map.addSource('openaip', {
    type: 'vector',
    tiles: [`https://api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.pbf?apiKey=${OPENAIP_KEY}`],
    minzoom: 0, maxzoom: 14,
  })
  map.addLayer({ id: 'airspace-ctr-fill', type: 'fill', source: 'openaip', 'source-layer': 'airspaces', filter: ['==', ['get', 'type'], 'ctr'], paint: { 'fill-color': 'rgba(220,50,50,0.03)' } })
  map.addLayer({ id: 'airspace-ctr-line', type: 'line', source: 'openaip', 'source-layer': 'airspaces', filter: ['==', ['get', 'type'], 'ctr'], paint: { 'line-color': 'rgba(220,50,50,0.9)', 'line-width': 2, 'line-dasharray': [4, 2] } })
  map.addLayer({ id: 'airspace-tma-fill', type: 'fill', source: 'openaip', 'source-layer': 'airspaces', filter: ['in', ['get', 'type'], ['literal', ['tma', 'cta']]], paint: { 'fill-color': 'rgba(0,0,0,0)' } })
  map.addLayer({ id: 'airspace-tma-line', type: 'line', source: 'openaip', 'source-layer': 'airspaces', filter: ['in', ['get', 'type'], ['literal', ['tma', 'cta']]], paint: { 'line-color': 'rgba(30,100,220,0.85)', 'line-width': 1.5 } })
  map.addLayer({ id: 'airspace-danger-fill', type: 'fill', source: 'openaip', 'source-layer': 'airspaces', filter: ['in', ['get', 'type'], ['literal', ['danger', 'restricted', 'prohibited']]], paint: { 'fill-color': 'rgba(0,0,0,0)' } })
  map.addLayer({ id: 'airspace-danger-line', type: 'line', source: 'openaip', 'source-layer': 'airspaces', filter: ['in', ['get', 'type'], ['literal', ['danger', 'restricted', 'prohibited']]], paint: { 'line-color': 'rgba(255,140,0,0.9)', 'line-width': 1.5, 'line-dasharray': [3, 2] } })

  // (2026-08-17) Couches HIGHLIGHT de zone (clic sur une ligne du popup) : trame de fond de la
  // couleur du type + contour NET épais. Filtre « rien » par défaut, piloté par setFilter.
  const HL_NONE = ['==', ['get', 'name'], '__none__']
  const HL_FILL = ['match', ['get', 'type'],
    'ctr', 'rgba(220,50,50,0.20)',
    'tma', 'rgba(30,100,220,0.18)', 'cta', 'rgba(30,100,220,0.18)',
    'rgba(255,140,0,0.20)']
  const HL_LINE = ['match', ['get', 'type'],
    'ctr', 'rgba(220,50,50,1)',
    'tma', 'rgba(30,100,220,1)', 'cta', 'rgba(30,100,220,1)',
    'rgba(255,140,0,1)']
  map.addLayer({ id: 'airspace-hl-fill', type: 'fill', source: 'openaip', 'source-layer': 'airspaces', filter: HL_NONE, paint: { 'fill-color': HL_FILL } })
  map.addLayer({ id: 'airspace-hl-line', type: 'line', source: 'openaip', 'source-layer': 'airspaces', filter: HL_NONE, paint: { 'line-color': HL_LINE, 'line-width': 4 } })

  map.addLayer({ id: 'airports', type: 'circle', source: 'openaip', 'source-layer': 'airports', paint: { 'circle-radius': 4, 'circle-color': dark ? '#FFFFFF' : '#141414', 'circle-stroke-width': 1.5, 'circle-stroke-color': dark ? '#141414' : '#FFFFFF' } })
  map.addLayer({ id: 'airports-labels', type: 'symbol', source: 'openaip', 'source-layer': 'airports', layout: { 'text-field': ['get', 'icao_code'], 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top' }, paint: { 'text-color': dark ? '#FFFFFF' : '#141414', 'text-halo-color': dark ? '#141414' : '#FFFFFF', 'text-halo-width': 1.5 } })
  const f = getAirportFilter(activeAirportTypes)
  map.setFilter('airports', f)
  map.setFilter('airports-labels', f)
}

// ── Contrôles du panneau Layers (22/09, Claude Design « Live ») — déclarés AU NIVEAU MODULE (sinon remontés
//    à chaque rendu et le glisser casse, cf. CLAUDE.md). Piste 4 px #2C2C2C, poignée 12 px, interrupteur 30×16.
function Switch({ on, onClick, label, disabled }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick} disabled={disabled} className="ak-focus"
      style={{ all: 'unset', cursor: 'pointer', flexShrink: 0, width: 30, height: 16, boxSizing: 'border-box', borderRadius: 999, padding: '0 2px',
               display: 'flex', alignItems: 'center', justifyContent: on ? 'flex-end' : 'flex-start', background: on ? T.amber : T.ruleDark }}>
      <span style={{ width: 12, height: 12, borderRadius: 999, background: on ? T.ink : T.etch }} />
    </button>
  )
}

// Curseur simple (trame d'un espace aérien, 0-30 %).
function SliderTrack({ value, max = 30, color, onChange, label }) {
  const pct = (value / max) * 100
  return (
    <div style={{ position: 'relative', height: 12, display: 'flex', alignItems: 'center' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, height: 4, background: T.ruleDark, borderRadius: 999 }} />
      <div style={{ position: 'absolute', left: 0, width: `${pct}%`, height: 4, background: color, borderRadius: 999 }} />
      <div style={{ position: 'absolute', left: `calc(${pct}% - 6px)`, width: 12, height: 12, borderRadius: 999, background: T.white, pointerEvents: 'none' }} />
      <input type="range" min={0} max={max} step={1} value={value} aria-label={label} className="ak-focus"
        onChange={e => onChange(Number(e.target.value))}
        style={{ position: 'absolute', width: '100%', opacity: 0, cursor: 'pointer', height: 12, margin: 0 }} />
    </div>
  )
}

// Bande d'altitude à DEUX poignées (pointeur : la poignée la plus proche suit ; clavier : flèches ±500 ft).
const BAND_STEP = 500
function BandSlider({ range, onChange, disabled }) {
  const trackRef = useRef(null)
  const dragRef = useRef(null)
  const toVal = (clientX) => {
    const r = trackRef.current.getBoundingClientRect()
    const v = Math.round(((clientX - r.left) / r.width) * ALT_MAX / BAND_STEP) * BAND_STEP
    return Math.max(0, Math.min(ALT_MAX, v))
  }
  const setIdx = (idx, v) => onChange(idx === 0 ? [Math.min(v, range[1] - 1000), range[1]] : [range[0], Math.max(v, range[0] + 1000)])
  const down = (e) => {
    if (disabled) return
    const v = toVal(e.clientX)
    dragRef.current = Math.abs(v - range[0]) <= Math.abs(v - range[1]) ? 0 : 1
    e.currentTarget.setPointerCapture(e.pointerId)
    setIdx(dragRef.current, v)
  }
  const move = (e) => { if (dragRef.current != null) setIdx(dragRef.current, toVal(e.clientX)) }
  const up = () => { dragRef.current = null }
  const key = (idx) => (e) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? BAND_STEP : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -BAND_STEP : 0
    if (!d) return
    e.preventDefault()
    setIdx(idx, Math.max(0, Math.min(ALT_MAX, range[idx] + d)))
  }
  const l = (range[0] / ALT_MAX) * 100, r = (range[1] / ALT_MAX) * 100
  const thumb = (idx, pct) => (
    <div role="slider" tabIndex={disabled ? -1 : 0} className="ak-focus" onKeyDown={key(idx)}
      aria-label={idx === 0 ? 'Traffic band floor' : 'Traffic band ceiling'}
      aria-valuemin={0} aria-valuemax={ALT_MAX} aria-valuenow={range[idx]} aria-valuetext={formatAlt(range[idx])}
      style={{ position: 'absolute', left: `calc(${pct}% - 6px)`, top: 0, width: 12, height: 12, borderRadius: 999,
               background: disabled ? T.etch : T.white, cursor: disabled ? 'default' : 'grab' }} />
  )
  return (
    <div ref={trackRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
      style={{ position: 'relative', height: 12, touchAction: 'none', cursor: disabled ? 'default' : 'pointer' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 4, height: 4, background: T.ruleDark, borderRadius: 999 }} />
      <div style={{ position: 'absolute', left: `${l}%`, width: `${r - l}%`, top: 4, height: 4, background: disabled ? T.ruleDark : T.etch, borderRadius: 999 }} />
      {thumb(0, l)}{thumb(1, r)}
    </div>
  )
}

// Symbole avion de la légende (même dessin que le mock Claude Design).
const LEGEND_PLANE = 'M0,-7 L1.2,-1.5 L7,1.6 L7,3 L1.2,2.4 L0.9,6 L3,8 L3,9 L0,8.2 L-3,9 L-3,8 L-0.9,6 L-1.2,2.4 L-7,3 L-7,1.6 L-1.2,-1.5 Z'
function LegendRow({ color, ring, text, muted, outline }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
      <svg width="22" height="22" viewBox="-13 -13 26 26" aria-hidden="true" style={{ display: 'block' }}>
        {ring && <circle cx="0" cy="0" r="11" fill="none" stroke={T.amber} strokeWidth="1.5" />}
        <path d={LEGEND_PLANE} fill={color} stroke={outline || 'none'} strokeWidth={outline ? 1 : 0} />
      </svg>
      <span style={{ fontFamily: T.sans, fontSize: 12, color: muted ? T.etch : T.white }}>{text}</span>
    </div>
  )
}

// Poll du trafic SafeSky, local à la carte LIVE : même requête, même intervalle et mêmes
// conversions (m→ft, m/s→kt) que hooks/useSafeSky (laissé intact), avec en plus le suivi
// d'échec pour la bannière « Traffic unavailable » et un indicateur « premier poll terminé ».
// failures = nombre d'échecs consécutifs (réseau, HTTP non-OK, JSON invalide) ; 0 après un succès.
function useTrafficPoll(bounds) {
  const [traffic, setTraffic]   = useState([])
  const [failures, setFailures] = useState(0)
  const [ready, setReady]       = useState(false)
  const [nonce, setNonce]       = useState(0)    // (22/09) « Retry now » de la bannière → relance immédiate
  const { latMin, lonMin, latMax, lonMax } = bounds ?? {}

  useEffect(() => {
    if (latMin == null) return
    let stop = false
    const poll = async () => {
      try {
        const res = await fetch(
          `/safesky/traffic?lat_min=${latMin}&lon_min=${lonMin}&lat_max=${latMax}&lon_max=${lonMax}`
        )
        if (!res.ok) throw new Error(`SafeSky ${res.status}`)
        const data = await res.json()
        if (stop) return
        // ⚠️ API REST SafeSky /traffic = altitude en MÈTRES et ground_speed en m/s → ft et kt ici.
        if (data.nearby_traffic) setTraffic(data.nearby_traffic.map(t =>
          ({ ...t, altitude: t.altitude != null ? Math.round(t.altitude * 3.28084) : t.altitude,
             ground_speed: t.ground_speed != null ? t.ground_speed * 1.94384 : t.ground_speed })))
        setFailures(0)
      } catch (error) {
        if (stop) return
        console.error('SafeSky fetch error:', error)
        setFailures(n => n + 1)
      } finally {
        if (!stop) setReady(true)
      }
    }
    poll()
    const t = setInterval(poll, 3000)
    return () => { stop = true; clearInterval(t) }
  }, [latMin, lonMin, latMax, lonMax, nonce])

  return { traffic, failures, ready, retry: () => setNonce(n => n + 1) }
}

// (22/09) Props : flyTo {lat,lon,zoom} · onTrafficState(bool trafic indisponible) · topCenter = nœud posé en haut
// au centre (bandeau FLEET de LivePage), la bannière « Traffic unavailable » se place juste dessous.
export default function AerotraceMap({ flyTo = null, onTrafficState, topCenter = null }) {
  const { clubId } = useClub()
  const mapContainer = useRef(null)
  const map = useRef(null)
  const markersRef = useRef({})
  const [mapBounds, setMapBounds] = useState(null)
  const { traffic, failures: trafficFailures, retry: retryTraffic } = useTrafficPoll(mapBounds)
  const [, setFleetLoaded] = useState(false)   // 1re lecture Firestore de la flotte terminée
  const [, setBcnReady] = useState(false)   // 1er poll des balises flotte terminé
  const [fleetOwn, setFleetOwn] = useState(new Map())   // icao24(hex) -> 'club' | 'owner' (flotte du club courant)
  const [fleetRole, setFleetRole] = useState(new Map())  // callSign -> 'club' | 'owner' (balises AeroTrace)
  const [fleetBcn, setFleetBcn]   = useState({})         // callSign -> balise FlyADSL (avions HORS flux radar)
  // (2026-08-31, demande Christophe) PHOTO dans le popup : photo de la fiche club (aircraft.photoUrl)
  // prioritaire, sinon planespotters par hex/immat — fetch UNIQUEMENT à l'ouverture du popup.
  const fleetPhotoRef = useRef(new Map())   // HEX ou CALLSIGN (upper) -> {url,credit,link}
  const popupPhotoRef = useRef({})          // id cible -> {url,credit,link} | false(introuvable) | null(fetch en cours)
  const [aspItems, setAspItems]   = useState(null)       // (2026-08-17) panneau espaces aériens (clic carte)
  const [aspHl, setAspHl]         = useState(null)       // nom de la zone surlignée (trame + contour épais)
  const drRef = useRef({})                               // dead-reckoning par cible (anticipation cap/vitesse)
  // Fond de carte : persisté (localStorage) — sans ça, chaque changement de page
  // démontait le composant et revenait au fond standard (demande Christophe 01/08).
  const [activeBasemap, setActiveBasemap] = useState(() => {
    const saved = localStorage.getItem('at_basemap')
    return BASEMAPS.some(b => b.id === saved) ? saved : 'dataviz-light'
  })
  useEffect(() => { localStorage.setItem('at_basemap', activeBasemap) }, [activeBasemap])
  const [visible, setVisible] = useState({ ctr: true, tma: true, danger: true, airports: true, traffic: true })
  const [opacity, setOpacity] = useState({ ctr: 3, tma: 0, danger: 0 })
  const [activeAirports, setActiveAirports] = useState(['fixed'])
  const [altRange, setAltRange] = useState([0, ALT_MAX])
  const [panelOpen, setPanelOpen] = useState(() => {
    try { return { layers: localStorage.getItem('ak_live_layers') !== '0', map: false } } catch { return { layers: true, map: false } }
  })
  useEffect(() => { try { localStorage.setItem('ak_live_layers', panelOpen.layers ? '1' : '0') } catch { /* ignore */ } }, [panelOpen.layers])
  const [showLegend, setShowLegend] = useState(true)
  // Réf. à jour des couches/trames : réappliquées après un changement de fond (setStyle recrée les couches).
  const layerStateRef = useRef({})
  useEffect(() => { layerStateRef.current = { visible, opacity } }, [visible, opacity])
  const [mapReady, setMapReady] = useState(false)

  useEffect(() => {
    if (!flyTo || !map.current || !mapReady) return
    map.current.flyTo({ center: [flyTo.lon, flyTo.lat], zoom: flyTo.zoom ?? 13, duration: 1200 })
  }, [flyTo, mapReady])

  // Flotte du club courant (highlight carte) : club = ROUGE, propriétaire = BLEU.
  // Filtré par clubId pour que super_admin voie la flotte du club sélectionné.
  useEffect(() => {
    if (!clubId) { setFleetOwn(new Map()); setFleetLoaded(true); return }
    setFleetLoaded(false)
    const q = query(collection(db, 'aircraft'), where('clubId', '==', clubId))
    getDocs(q)
      .then(snap => {
        const m = new Map(); const roles = new Map()
        snap.forEach(doc => {
          const d = doc.data()
          if (d.archived) return                                  // (T18) archivés hors vues live
          if (d.icao24)   m.set(d.icao24.toUpperCase(), d.ownership === 'owner' ? 'owner' : 'club')
          if (d.callSign) roles.set(d.callSign.toUpperCase(), d.ownership === 'owner' ? 'owner' : 'club')
          if (d.photoUrl) {   // (photo popup) fiche club → prioritaire sur planespotters
            const ph = { url: d.photoUrl, credit: d.photoCredit || '', link: d.photoLink || '', site: d.photoSource || '' }
            if (d.icao24)   fleetPhotoRef.current.set(d.icao24.toUpperCase(), ph)
            if (d.callSign) fleetPhotoRef.current.set(d.callSign.toUpperCase(), ph)
          }
        })
        setFleetOwn(m); setFleetRole(roles)
      })
      .catch(err => console.error('[AerotraceMap] aircraft load:', err))
      .finally(() => setFleetLoaded(true))
  }, [clubId])

  // Surlignage de zone : filtre des couches HL piloté par l'état (réappliqué au changement de fond,
  // les couches étant recréées avec un filtre « rien »)
  useEffect(() => {
    if (!map.current) return
    const f = aspHl ? ['==', ['get', 'name'], aspHl] : ['==', ['get', 'name'], '__none__']
    if (map.current.getLayer('airspace-hl-fill')) {
      map.current.setFilter('airspace-hl-fill', f)
      map.current.setFilter('airspace-hl-line', f)
    }
  }, [aspHl, activeBasemap, mapReady])

  const filteredTraffic = traffic.filter(ac => {
    const alt = ac.altitude || 0
    return alt >= altRange[0] && alt <= altRange[1]
  })

  // (2026-08-11) BALISES AeroTrace sur la carte : un FK9 SANS transpondeur n'existe pas dans le
  // flux radar uav-api → on interroge FlyADSL par callsign (comme la page En vol, poll 5 s) et on
  // l'affiche en marqueur dédié (dédupliqué si le radar voit déjà ce callsign).
  useEffect(() => {
    const signs = [...fleetRole.keys()]
    if (!signs.length) { setFleetBcn({}); setBcnReady(true); return }
    let stop = false
    const poll = async () => {
      try {
        const res = await fetch(`/safesky/fleet?call_signs=${signs.join(',')}`)
        if (res.ok) { const d = await res.json(); if (!stop) setFleetBcn(d.beacons ?? {}) }
      } catch { /* best-effort */ }
      finally { if (!stop) setBcnReady(true) }
    }
    poll()
    const t = setInterval(poll, 5000)
    return () => { stop = true; clearInterval(t) }
  }, [fleetRole])

  const radarSigns = new Set(filteredTraffic.map(a => (a.call_sign || '').toUpperCase()).filter(Boolean))
  const beaconTargets = Object.values(fleetBcn ?? {}).filter(b => {
    if (!b || b.latitude == null) return false
    const fresh = (Date.now() / 1000 - (b.timestamp ?? 0)) < 180
    return fresh && !radarSigns.has((b.call_sign || '').toUpperCase())
  }).map(b => ({
    id: `BCN_${b.call_sign}`,
    call_sign: b.call_sign,
    latitude: b.latitude, longitude: b.longitude,
    altitude: b.altitude != null ? Math.round(b.altitude * 3.28084) : 0,   // m → ft (FlyADSL = SI)
    ground_speed: b.ground_speed != null ? b.ground_speed * 1.94384 : 0,   // m/s → kt
    course: b.ground_track ?? 0,
    beacon_type: 'MOTORPLANE', status: b.flight_state ?? '',
    _ts: b.timestamp,                       // (2026-08-17) heure du FIX → ancrage DR
    _fleetBeacon: true,
  })).filter(a => (a.altitude || 0) >= altRange[0] && (a.altitude || 0) <= altRange[1])
  const allTargets = [...filteredTraffic, ...beaconTargets]

  // ── (21/09) État « flotte » : désormais dans FleetStrip (page Live, source useFleet = même que In flight).
  //    La carte ne garde que l'alerte trafic.
  const trafficDown  = trafficFailures >= 2    // 2 échecs consécutifs (~6 s) → évite le clignotement sur un raté isolé
  useEffect(() => { onTrafficState?.(trafficDown) }, [trafficDown, onTrafficState])

  const toggleLayer = (id) => {
    const next = { ...visible, [id]: !visible[id] }
    setVisible(next)
    if (!map.current || id === 'traffic') return
    ;(LAYER_IDS[id] || []).forEach(lid => {
      if (map.current.getLayer(lid))
        map.current.setLayoutProperty(lid, 'visibility', next[id] ? 'visible' : 'none')
    })
  }

  const handleOpacity = (id, val) => {
    setOpacity(prev => ({ ...prev, [id]: val }))
    const fillLayerId = `airspace-${id}-fill`
    if (map.current?.getLayer(fillLayerId))
      map.current.setPaintProperty(fillLayerId, 'fill-color', FILL_COLORS[id](val / 100))
  }

  const toggleAirportType = (typeId) => {
    const next = activeAirports.includes(typeId)
      ? activeAirports.filter(t => t !== typeId)
      : [...activeAirports, typeId]
    setActiveAirports(next)
    const f = getAirportFilter(next)
    if (map.current?.getLayer('airports')) map.current.setFilter('airports', f)
    if (map.current?.getLayer('airports-labels')) map.current.setFilter('airports-labels', f)
  }

  const changeBasemap = useCallback((styleId) => {
    if (!map.current) return
    setActiveBasemap(styleId)
    map.current.setStyle(`https://api.maptiler.com/maps/${styleId}/style.json?key=${MAPTILER_KEY}`)
    map.current.once('styledata', () => {
      addOpenAIPLayers(map.current, activeAirports, isDarkMap(styleId))
      // (22/09) avant : après un changement de fond, les couches masquées réapparaissaient et la trame revenait au défaut.
      const { visible: v, opacity: o } = layerStateRef.current
      Object.entries(LAYER_IDS).forEach(([id, lids]) => lids.forEach(lid => {
        if (map.current.getLayer(lid)) map.current.setLayoutProperty(lid, 'visibility', v[id] ? 'visible' : 'none')
      }))
      Object.entries(o).forEach(([id, val]) => {
        if (map.current.getLayer(`airspace-${id}-fill`)) map.current.setPaintProperty(`airspace-${id}-fill`, 'fill-color', FILL_COLORS[id](val / 100))
      })
    })
  }, [activeAirports])

  useEffect(() => {
    if (map.current) return
    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: `https://api.maptiler.com/maps/${activeBasemap}/style.json?key=${MAPTILER_KEY}`,
      center: [CENTER.lon, CENTER.lat],
      zoom: 9,
    })
    map.current.addControl(new maplibregl.NavigationControl(), 'top-right')

    const updateBounds = () => {
      const b = map.current.getBounds()
      setMapBounds({
        latMin: b.getSouth().toFixed(4),
        lonMin: b.getWest().toFixed(4),
        latMax: b.getNorth().toFixed(4),
        lonMax: b.getEast().toFixed(4),
      })
    }

    map.current.on('load', () => {
      addOpenAIPLayers(map.current, activeAirports, isDarkMap(activeBasemap))
      updateBounds()
      setMapReady(true)
    })
    // (2026-08-17) Clic hors icône avion (les marqueurs DOM interceptent leurs propres clics) →
    // popup des espaces aériens sous le curseur. Enregistré UNE fois au montage (survit aux
    // changements de style : l'événement est sur la map, pas sur les couches).
    map.current.on('click', (e) => {
      const layers = AIRSPACE_QUERY_LAYERS.filter(l => map.current.getLayer(l))
      if (!layers.length) return
      const feats = map.current.queryRenderedFeatures(e.point, { layers })
      // (2026-08-17) le dialogue vit dans un COIN de l'écran (panneau React bas-gauche), pas en
      // popup sur la zone → le surlignage reste entièrement visible. Clic dans le vide = fermer.
      if (!feats.length) { setAspItems(null); setAspHl(null); return }
      setAspHl(null)
      setAspItems(airspaceItems(feats))
    })
    map.current.on('moveend', updateBounds)
    // (22/09) le panneau In flight se replie / se déplie → la carte change de largeur sans resize de fenêtre.
    const ro = new ResizeObserver(() => map.current?.resize())
    ro.observe(mapContainer.current)
    return () => { ro.disconnect(); map.current?.remove(); map.current = null }
  }, [])

  // Marqueurs trafic — RÉCONCILIÉS EN PLACE (pas de teardown/recreate à chaque poll).
  // Avant : on rasait tous les marqueurs et on recréait chaque <img> → le SVG se rechargeait
  // et « flashait » en noir (icône sans filtre) une frame avant que le filtre CSS s'applique.
  // Maintenant : on crée le marqueur une seule fois, puis on ne met à jour icône/filtre/rotation/
  // label QUE si sa signature a changé → plus de clignotement rouge↔noir.
  useEffect(() => {
    if (!map.current) return
    if (!visible.traffic) {
      Object.values(markersRef.current).forEach(o => o.marker.remove())
      markersRef.current = {}
      return
    }

    const seen = new Set()
    allTargets.forEach(ac => {
      // Appartenance flotte : par HEX (icao24) OU par CALLSIGN. Les FK9 club sans transpondeur
      // apparaissent dans SafeSky avec un hex ≠ leur icao24 enregistré → le match par callsign
      // (immatriculation) les reconnaît quand même comme flotte (rouge) au lieu de trafic (bleu).
      const own      = ac._fleetBeacon
        ? fleetRole.get((ac.call_sign || '').toUpperCase())
        : (fleetOwn.get((ac.id || '').toUpperCase()) || fleetRole.get((ac.call_sign || '').toUpperCase()))   // 'club' | 'owner' | undefined
      const isFleet  = !!own                                       // membre flotte EBBY = émet via ATC
      const isOwner  = own === 'owner'                             // conservé pour le popup (owner/club)

      // (22/09) Flotte = avion blanc (encre sur fond clair) dans un anneau ambre · partageurs SafeSky = bleu info ·
      // radio (ADS-B / Mode-S / FLARM, simplement capté) = gris etch. Un type inconnu/vide = réseau → bleu.
      const isSharer   = ac._fleetBeacon || !RADIO_SRC.has(String(ac.transponder_type || '').toUpperCase())
      const darkMap    = isDarkMap(activeBasemap)
      const fg         = darkMap ? T.white : T.ink
      // (22/09, Christophe) radio = quasi-noir sur fond clair (blanc sur fond sombre), plus grand : le gris etch se perdait.
      const symClr     = isFleet || !isSharer ? fg : SAFESKY_CLR
      const callClr    = symClr
      const altClr     = isFleet || !isSharer ? (darkMap ? T.mutedDark : T.graphite) : T.etch
      const iconSrc    = `/icons/${iconForBeacon(ac.beacon_type)}.svg`
      const rot        = ac.course || 0
      const callTxt    = ac.call_sign || ac.id
      const altTxt     = `${ac.altitude || 0}`
      seen.add(ac.id)

      // (2026-08-17) ANCRAGE SUR L'HEURE DU FIX (last_update radar / timestamp balise), plus sur
      // l'heure d'arrivée du poll. Deux maux guéris d'un coup (comparaison côte à côte Christophe
      // vs live.safesky.app) : (a) le RETARD permanent = l'âge du fix (3-15 s) disparaît — on
      // extrapole depuis l'instant réel de la mesure, comme le viewer SafeSky ; (b) re-servir le
      // MÊME fix au poll suivant ne redémarre plus l'extrapolation depuis l'ancienne position
      // (c'était la « MARCHE ARRIÈRE » : avance 5 s → recule → avance — le bug base_ms de l'écran
      // v207, jamais reporté ici). Un fix identique ré-ancre au même point : continuité parfaite.
      const rawTs = ac._fleetBeacon ? ac._ts : ac.last_update
      let fixMs = Number(rawTs) || 0
      if (fixMs > 1e12) { /* déjà en ms */ } else if (fixMs > 1e9) { fixMs *= 1000 } else { fixMs = Date.now() }
      const prevDr  = drRef.current[ac.id]
      const dispLat = prevDr ? prevDr.dispLat : ac.latitude
      const dispLon = prevDr ? prevDr.dispLon : ac.longitude
      drRef.current[ac.id] = { lat: ac.latitude, lon: ac.longitude, gs: ac.ground_speed || 0,
                               course: rot, turn: Number(ac.turn_rate) || 0, fixMs, dispLat, dispLon,
                               // (23/09) cap AFFICHÉ (lissé, déduit du déplacement réel à l'écran)
                               dispBrg: prevDr ? prevDr.dispBrg : rot }

      let o = markersRef.current[ac.id]
      if (!o) {
        const el = document.createElement('div')
        el.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;'
        const sym = document.createElement('div')          // boîte du symbole (26 px, 40 px avec anneau flotte)
        sym.style.cssText = 'position:relative;display:flex;align-items:center;justify-content:center;'
        const ring = document.createElement('div')
        ring.style.cssText = `position:absolute;inset:0;border-radius:50%;border:1.5px solid ${T.amber};box-sizing:border-box;`
        const img = document.createElement('div')          // icône par type, colorée par masque CSS
        img.style.cssText = 'transform-origin:center center;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;-webkit-mask-position:center;mask-position:center;-webkit-mask-size:contain;mask-size:contain;'
        sym.append(ring, img)
        const lbl = document.createElement('div')
        lbl.style.cssText = 'text-align:center;white-space:nowrap;font-family:var(--font-mono);font-size:11px;font-weight:500;line-height:1.3;font-variant-numeric:tabular-nums;'
        const callEl = document.createElement('div')
        const altEl  = document.createElement('div')
        lbl.append(callEl, altEl); el.append(sym, lbl)
        const popup = new maplibregl.Popup({ offset: 25 })
        const marker = new maplibregl.Marker({ element: el })
          .setLngLat([dispLon, dispLat])
          .setPopup(popup)
          .addTo(map.current)
        o = { marker, sym, ring, img, lbl, callEl, altEl, sig: '', bodyHtml: '' }
        markersRef.current[ac.id] = o
        // (photo popup) fetch à l'OUVERTURE seulement : fiche club d'abord, sinon planespotters
        // (hex si l'id en est un, sinon immat). Résultat mémorisé → réouvertures instantanées.
        const tgtId = ac.id
        popup.on('open', () => {
          const cur = popupPhotoRef.current[tgtId]
          if (cur !== undefined && cur !== null) return   // déjà résolu (photo ou false)
          const rec = markersRef.current[tgtId]; if (!rec) return
          const stored = fleetPhotoRef.current.get((rec.callEl.textContent || '').toUpperCase())
            || (/^[0-9A-F]{6}$/i.test(tgtId) ? fleetPhotoRef.current.get(tgtId.toUpperCase()) : null)
          const apply = (v) => {
            popupPhotoRef.current[tgtId] = v || false
            const r2 = markersRef.current[tgtId]
            if (r2 && popup.isOpen()) popup.setHTML(popupPhotoHtml(v) + r2.bodyHtml)
          }
          if (stored) return apply(stored)
          if (cur === null) return                        // fetch déjà en cours
          popupPhotoRef.current[tgtId] = null
          fetchWebPhoto({ hex: /^[0-9A-F]{6}$/i.test(tgtId) ? tgtId : undefined,
                          reg: rec.callEl.textContent || undefined }).then(apply)
        })
      }

      // MAJ visuelle SEULEMENT si un attribut a changé (le src ne bouge pas → pas de reload SVG)
      const sig = `${iconSrc}|${symClr}|${isFleet}|${rot}|${callClr}|${altClr}|${callTxt}|${altTxt}`
      if (o.sig !== sig) {
        const box = isFleet ? 44 : 34, icon = isFleet ? 28 : 34
        o.sym.style.width = o.sym.style.height = `${box}px`
        o.ring.style.display = isFleet ? 'block' : 'none'
        o.img.style.width = o.img.style.height = `${icon}px`
        o.img.style.webkitMaskImage = o.img.style.maskImage = `url(${iconSrc})`
        o.img.style.background = symClr
        o.img.style.transform = `rotate(${rot}deg)`
        o.callEl.style.color = callClr; o.callEl.textContent = callTxt
        o.altEl.style.color  = altClr;  o.altEl.textContent  = altTxt
        o.sig = sig
      }

      const srcLine = isFleet ? `Club fleet · AKcore · ${isOwner ? 'owner' : 'club'}`
        : isSharer ? 'SafeSky user' : `Radio traffic · ${ac.transponder_type || 'ADS-B'}`
      const dotClr = isFleet ? T.amber : (isSharer ? SAFESKY_CLR : T.ink)
      o.bodyHtml = `
          <div style="font-family:var(--font-sans);font-size:12px;line-height:1.5;color:${T.ink};min-width:170px;">
            <div style="font-family:var(--font-mono);font-size:15px;font-weight:500;">${callTxt}</div>
            <div style="display:flex;align-items:center;gap:6px;color:${T.graphite};margin-bottom:6px;">
              <span style="width:8px;height:8px;border-radius:999px;background:${dotClr};flex-shrink:0;"></span>${srcLine}
            </div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;font-family:var(--font-mono);font-variant-numeric:tabular-nums;">
              <div><div style="font-size:10px;letter-spacing:0.08em;color:${T.etch};">ALT FT</div><div style="font-size:14px;">${ac.altitude ?? '−−−'}</div></div>
              <div><div style="font-size:10px;letter-spacing:0.08em;color:${T.etch};">GS KT</div><div style="font-size:14px;">${ac.ground_speed != null ? Math.round(ac.ground_speed) : '−−−'}</div></div>
              <div><div style="font-size:10px;letter-spacing:0.08em;color:${T.etch};">HDG</div><div style="font-size:14px;">${ac.course != null ? String(Math.round(ac.course) % 360).padStart(3, '0') : '−−−'}</div></div>
            </div>
            <div style="font-family:var(--font-mono);font-size:10px;letter-spacing:0.08em;color:${T.etch};margin-top:6px;">${String(ac._fleetBeacon ? 'ADS-L beacon' : (ac.beacon_type || '')).toUpperCase()}${ac.status ? ` · ${String(ac.status).toUpperCase()}` : ''}</div>
          </div>`
      o.marker.getPopup().setHTML(popupPhotoHtml(popupPhotoRef.current[ac.id]) + o.bodyHtml)
    })

    // retirer les marqueurs des cibles disparues du flux
    Object.keys(markersRef.current).forEach(id => {
      if (!seen.has(id)) { markersRef.current[id].marker.remove(); delete markersRef.current[id]; delete drRef.current[id] }
    })
  }, [allTargets, fleetRole, fleetOwn, visible.traffic, activeBasemap])

  // (2026-08-11) DEAD RECKONING d'affichage (demande Christophe) : entre deux polls (5 s), chaque
  // cible avance au cap/vitesse connus ; quand la position réelle arrive, l'affichage CONVERGE
  // vers elle au lieu de sauter. Gardes : pas d'anticipation sous 15 kt (jitter sol) ni au-delà
  // de 30 s sans donnée (cible gelée).
  //
  // (23/09, retour Christophe « les avions se déplacent en crabe, ce n'est pas fluide ») DEUX
  // CORRECTIONS, qui expliquaient l'écart avec le viewer SafeSky :
  //  1. CADENCE — la boucle tournait à 500 ms : 2 images par seconde, donc un déplacement en
  //     escalier. Elle passe en requestAnimationFrame (≈60 Hz) avec un lissage exponentiel
  //     piloté par le temps écoulé (constante de temps 1,2 s) : même vitesse de convergence
  //     qu'avant, mais continue. Coupée automatiquement quand l'onglet passe en arrière-plan.
  //  2. LE CRABE — l'icône était orientée au cap transmis, alors que la correction de position
  //     (retour vers le vrai point quand le fix arrive) se fait dans une direction QUELCONQUE :
  //     l'avion glissait de biais tout en pointant ailleurs. L'icône est maintenant orientée
  //     sur son déplacement RÉELLEMENT AFFICHÉ, lissé — elle pointe donc toujours là où elle
  //     va. Sous 15 kt (ou déplacement négligeable) on retombe sur le cap transmis, sinon le
  //     bruit de position ferait tourner l'avion sur place au parking.
  useEffect(() => {
    let raf = 0, last = performance.now()
    const TAU = 1200   // ms — constante de temps de convergence vers la position vraie
    const tick = (now) => {
      const dt = Math.min(now - last, 250); last = now
      const k  = 1 - Math.exp(-dt / TAU)    // lissage indépendant de la cadence d'images
      Object.entries(drRef.current).forEach(([key, d]) => {
        const o = markersRef.current[key]
        if (!o) return
        // l'âge se mesure sur l'horloge murale : fixMs est un timestamp epoch, alors que
        // l'argument de requestAnimationFrame part du chargement de la page.
        let age = (Date.now() - d.fixMs) / 1000
        if (age < 0) age = 0                                     // garde horloge client en avance
        let tgtLat = d.lat, tgtLon = d.lon
        if (d.gs > 15 && age < 60) {
          const dist = d.gs * 0.514444 * age                     // kt → mètres parcourus
          // (2026-08-17) anticipation COURBE : turn_rate (°/s) du flux radar → cap moyen sur
          // l'intervalle = course + turn·age/2 (arc approx). En tour de piste le virage est
          // suivi au lieu de « couper » tout droit. Clamp ±180° cumulés (anti-dérive).
          let hdg = d.course || 0
          if (Math.abs(d.turn) > 0.5 && Math.abs(d.turn) < 15) {
            const dturn = Math.max(-180, Math.min(180, d.turn * age))
            hdg += dturn / 2
          }
          const cr = hdg * Math.PI / 180
          tgtLat = d.lat + (dist * Math.cos(cr)) / 111320
          tgtLon = d.lon + (dist * Math.sin(cr)) / (111320 * Math.cos(d.lat * Math.PI / 180))
        }
        const pLat = d.dispLat, pLon = d.dispLon
        d.dispLat += (tgtLat - d.dispLat) * k
        d.dispLon += (tgtLon - d.dispLon) * k
        o.marker.setLngLat([d.dispLon, d.dispLat])

        // Orientation = direction du déplacement AFFICHÉ (fin du crabe)
        const dLat = d.dispLat - pLat
        const dLon = (d.dispLon - pLon) * Math.cos(d.dispLat * Math.PI / 180)
        if (d.gs > 15 && (Math.abs(dLat) > 1e-9 || Math.abs(dLon) > 1e-9)) {
          const brg = (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360
          let diff = ((brg - d.dispBrg + 540) % 360) - 180        // plus court chemin angulaire
          d.dispBrg = (d.dispBrg + diff * Math.min(1, dt / 250) + 360) % 360
        } else if (d.course != null) {
          let diff = ((d.course - d.dispBrg + 540) % 360) - 180
          d.dispBrg = (d.dispBrg + diff * Math.min(1, dt / 400) + 360) % 360
        }
        if (o.img) o.img.style.transform = `rotate(${d.dispBrg.toFixed(1)}deg)`
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const onVis = () => { last = performance.now() }               // retour d'onglet : pas de saut
    document.addEventListener('visibilitychange', onVis)
    return () => { cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis) }
  }, [])

  // ── Habillage (22/09, Claude Design « Live ») : panneaux encre, bord 1 px #2C2C2C, rayon 6, aucune ombre.
  const inkPanel = { background: T.ink, border: `1px solid ${T.ruleDark}`, borderRadius: 6 }
  const rowText = (on) => ({ fontFamily: T.sans, fontSize: 12, color: on ? T.white : T.mutedDark })
  const bandCount = allTargets.length
  const chevron = (open) => (
    <span style={{ display: 'flex', color: T.etch, transform: open ? 'rotate(90deg)' : 'none' }}><Icon name="chevron-right" size={16} /></span>
  )

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', background: T.ink }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

      {/* Haut, centre : bandeau FLEET (LivePage) + bannière trafic indisponible */}
      <div style={{ position: 'absolute', top: 20, left: 252, right: 60, zIndex: 11, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, pointerEvents: 'none' }}>
        {topCenter}
        {trafficDown && (
          <div style={{ width: 520, maxWidth: '100%', pointerEvents: 'auto' }}>
            <Banner tone="caution" title="Traffic unavailable, retrying…" retryLabel="Retry now" onRetry={retryTraffic}>
              SafeSky and the ADS-B feed did not answer. Club aircraft fitted with an AKcore are still shown.
            </Banner>
          </div>
        )}
      </div>

      {/* Haut, gauche : LAYERS */}
      <div style={{ ...inkPanel, position: 'absolute', left: 20, top: 20, width: 212, zIndex: 10, maxHeight: 'calc(100% - 40px)', overflowY: 'auto' }}>
        <button type="button" className="ak-focus" onClick={() => setPanelOpen(p => ({ ...p, layers: !p.layers }))} aria-expanded={panelOpen.layers}
          title={panelOpen.layers ? 'Collapse layers' : 'Show layers'}
          style={{ all: 'unset', boxSizing: 'border-box', width: '100%', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                   padding: '10px 12px', borderBottom: panelOpen.layers ? `1px solid ${T.ruleDark}` : 'none' }}>
          <span style={labelStyle(T.mutedDark)}>LAYERS</span>
          {chevron(panelOpen.layers)}
        </button>

        {panelOpen.layers && (
          <div style={{ padding: 12 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {LAYERS.filter(l => l.id !== 'traffic').map(layer => {
                const on = visible[layer.id]
                return (
                  <div key={layer.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div onClick={() => toggleLayer(layer.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 2, border: `1.5px solid ${on ? layer.color : T.etch}`, background: on ? `rgba(${layer.rgb},${Math.max(0.15, (opacity[layer.id] ?? 0) / 30)})` : 'transparent' }} />
                        <span style={rowText(on)}>{layer.label}</span>
                      </span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }} onClick={e => e.stopPropagation()}>
                        {layer.hasSlider && on && <span style={monoStyle(11, T.mutedDark)}>{opacity[layer.id]}%</span>}
                        <Switch on={on} onClick={() => toggleLayer(layer.id)} label={`Show ${layer.label}`} />
                      </span>
                    </div>
                    {layer.hasSlider && on && (
                      <SliderTrack value={opacity[layer.id]} max={30} color={layer.color} label={`${layer.label} shading`} onChange={v => handleOpacity(layer.id, v)} />
                    )}
                    {layer.id === 'airports' && on && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 18 }}>
                        {AIRPORT_TYPES.map(t => {
                          const checked = activeAirports.includes(t.id)
                          return (
                            <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', userSelect: 'none' }}>
                              <input type="checkbox" className="ak-focus" checked={checked} onChange={() => toggleAirportType(t.id)}
                                style={{ appearance: 'none', WebkitAppearance: 'none', margin: 0, width: 10, height: 10, borderRadius: 2, cursor: 'pointer',
                                         border: `1.5px solid ${checked ? T.white : T.etch}`, background: checked ? T.white : 'transparent' }} />
                              <span style={{ ...rowText(checked), fontSize: 11 }}>{t.label}</span>
                            </label>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Trafic : interrupteur + bande d'altitude */}
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.ruleDark}` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={labelStyle(T.mutedDark)}>TRAFFIC BAND</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={monoStyle(11, trafficDown || !visible.traffic ? T.mutedDark : T.white)}>{trafficDown ? '−−−' : `${bandCount} AC`}</span>
                  <Switch on={visible.traffic} onClick={() => toggleLayer('traffic')} label="Show traffic" />
                </span>
              </div>
              <BandSlider range={altRange} onChange={setAltRange} disabled={trafficDown || !visible.traffic} />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
                <span style={monoStyle(11, trafficDown ? T.mutedDark : T.white)}>{formatAlt(altRange[0])}</span>
                <span style={monoStyle(11, trafficDown ? T.mutedDark : T.white)}>{formatAlt(altRange[1])}</span>
              </div>
            </div>

            {/* Fond de carte */}
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.ruleDark}` }}>
              <div style={{ ...labelStyle(T.mutedDark), marginBottom: 8 }}>MAP</div>
              <div role="radiogroup" aria-label="Map type" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {BASEMAPS.map(bm => {
                  const on = activeBasemap === bm.id
                  return (
                    <button key={bm.id} type="button" role="radio" aria-checked={on} className="ak-focus" onClick={() => changeBasemap(bm.id)}
                      style={{ all: 'unset', cursor: 'pointer', padding: '3px 8px', borderRadius: 4, fontFamily: T.sans, fontSize: 11,
                               border: `1px solid ${on ? T.white : T.ruleDark}`, color: on ? T.white : T.mutedDark }}>
                      {bm.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Bas, gauche : espaces aériens sous le clic */}
      {aspItems && (
        <div style={{ ...inkPanel, position: 'absolute', left: 20, bottom: 36, zIndex: 10, width: 280, maxHeight: '42vh', overflowY: 'auto', padding: '10px 12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={labelStyle(T.mutedDark)}>AIRSPACES</span>
            <button type="button" className="ak-focus" onClick={() => { setAspItems(null); setAspHl(null) }} title="Close"
              style={{ all: 'unset', cursor: 'pointer', display: 'flex', color: T.etch }}><Icon name="close" size={16} /></button>
          </div>
          {aspItems.map((it, i) => (
            <div key={i} onClick={() => setAspHl(aspHl === it.name ? null : it.name)} title="Click to highlight the area on the map"
                 style={{ margin: '6px 0', padding: '4px 8px', borderLeft: `3px solid ${it.color}`, borderRadius: 3, cursor: 'pointer',
                          background: aspHl === it.name ? '#1E1E1E' : 'transparent' }}>
              <div style={{ fontFamily: T.sans, fontSize: 12, color: T.white, fontWeight: 600 }}>
                {it.name} <span style={{ color: T.mutedDark, fontWeight: 400 }}>({it.typ}{it.cls ? ` · class ${it.cls}` : ''})</span>
              </div>
              <div style={monoStyle(11, T.mutedDark)}>{it.lo} – {it.up}</div>
            </div>
          ))}
        </div>
      )}

      {/* Bas, droite : LÉGENDE (repliable) */}
      <div style={{ ...inkPanel, position: 'absolute', right: 16, bottom: 36, zIndex: 10, padding: showLegend ? '12px 14px' : '8px 12px', display: 'flex', flexDirection: 'column', gap: 9 }}>
        <button type="button" className="ak-focus" onClick={() => setShowLegend(v => !v)} aria-expanded={showLegend} title={showLegend ? 'Hide legend' : 'Show legend'}
          style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={labelStyle(T.mutedDark)}>LEGEND</span>{chevron(showLegend)}
        </button>
        {showLegend && (<>
          <LegendRow ring color={T.white} text="Club fleet · AKcore" />
          <LegendRow color={trafficDown ? T.etch : SAFESKY_CLR} text={trafficDown ? 'SafeSky user · feed down' : 'SafeSky user'} muted={trafficDown} />
          <LegendRow color={trafficDown ? T.etch : T.ink} outline={trafficDown ? null : T.white} text={trafficDown ? 'Radio traffic · feed down' : 'Radio traffic · ADS-B / FLARM'} muted={trafficDown} />
        </>)}
      </div>
    </div>
  )
}
