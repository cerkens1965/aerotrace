/**
 * ReplayMap.jsx — AeroTrace Replay Map
 * Carte de replay 2D/3D pour instructeurs aviation
 *
 * Props:
 *   frames       — tableau de frames G3X parsées
 *   currentFrame — frame courante (null si aucun vol chargé)
 *   is3D         — boolean, mode 3D cockpit actif
 *   isPlaying    — boolean, replay en cours (caméra asservie si true)
 *   speed        — vitesse de replay (1x, 2x, 5x, 10x, 38x)
 */

import { useEffect, useRef, useState, useCallback } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { subsampleFrames } from '../../utils/csvParser'
import { T, labelStyle, monoStyle, Icon } from '../ui'

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY
const OPENAIP_KEY  = import.meta.env.VITE_OPENAIP_KEY

// ─── CONSTANTES ──────────────────────────────────────────────────────────────

const BASEMAPS = [
  { id: 'dataviz-light', label: 'Light',     dark: false },
  { id: 'dataviz-dark',  label: 'Dark',      dark: true  },
  { id: 'outdoor-v2',    label: 'Topo',      dark: false },
  { id: 'satellite',     label: 'Satellite', dark: true  },
  { id: 'basic-v2',      label: 'Basic',     dark: false },
]
const DARK_MAPS = new Set(['dataviz-dark', 'satellite'])

const LAYERS = [
  { id: 'ctr',      label: 'CTR',      color: '#dc3232', rgb: '220,50,50',  hasSlider: true  },
  { id: 'tma',      label: 'TMA / CTA',  color: '#1e64dc', rgb: '30,100,220', hasSlider: true  },
  { id: 'danger',   label: 'Danger areas', color: '#ff8c00', rgb: '255,140,0',  hasSlider: true  },
  { id: 'airports', label: 'Airports', color: '#4a7ab5', rgb: '74,122,181', hasSlider: false },
]
const LAYER_IDS = {
  ctr:      ['airspace-ctr-fill',    'airspace-ctr-line'   ],
  tma:      ['airspace-tma-fill',    'airspace-tma-line'   ],
  danger:   ['airspace-danger-fill', 'airspace-danger-line'],
  airports: ['airports',             'airports-labels'      ],
}
const FILL_COLORS = {
  ctr:    o => `rgba(220,50,50,${o})`,
  tma:    o => `rgba(30,100,220,${o})`,
  danger: o => `rgba(255,140,0,${o})`,
}
const AIRPORT_TYPES = [
  { id: 'fixed', label: 'Aerodromes · ULM · military' },
  { id: 'heli',  label: 'Helipads'                    },
  { id: 'sea',   label: 'Seaplane bases'              },
]

// (22/09) mêmes couleurs de phase que la frise de la page Loop (charte AirKi : jamais de rouge).
const PHASE_COLORS = {
  GROUND:   '#ffffff',
  CRUISE:   T.ok,
  MANEUVER: T.info,
  APPROACH: T.amber,
  CRITICAL: T.ink,
}
const PHASE_LABELS = { CRUISE: 'Cruise', MANEUVER: 'Manoeuvre', APPROACH: 'Approach', CRITICAL: 'Critical' }

// ─── HELPERS GÉOGRAPHIQUES ───────────────────────────────────────────────────

/** Point à distance km devant un cap (haversine) */
function getAheadPoint(lon, lat, bearingDeg, distanceKm) {
  const R  = 6371
  const d  = distanceKm / R
  const b  = bearingDeg * Math.PI / 180
  const φ1 = lat * Math.PI / 180
  const λ1 = lon * Math.PI / 180
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(b))
  const λ2 = λ1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
  return [(λ2 * 180) / Math.PI, (φ2 * 180) / Math.PI]
}

/** Moyenne circulaire d'un tableau de caps (évite l'aliasing 359°→1°) */
function circularMean(bearings) {
  if (!bearings.length) return 0
  const s = bearings.reduce((a, b) => a + Math.sin(b * Math.PI / 180), 0)
  const c = bearings.reduce((a, b) => a + Math.cos(b * Math.PI / 180), 0)
  return ((Math.atan2(s, c) * 180 / Math.PI) + 360) % 360
}

// ─── MAPLIBRE HELPERS ────────────────────────────────────────────────────────

function getAirportFilter(active) {
  if (!active.length) return ['==', 'type', 'NONE']
  const parts = []
  if (active.includes('fixed')) parts.push(['in', ['get', 'type'], ['literal', ['apt', 'af_civil', 'ad_mil', 'light_aircraft']]])
  if (active.includes('heli'))  parts.push(['==', ['get', 'type'], 'heli_civil'])
  if (active.includes('sea'))   parts.push(['==', ['get', 'type'], 'af_water'])
  return parts.length === 1 ? parts[0] : ['any', ...parts]
}

function addOpenAIPLayers(map, activeAirportTypes) {
  if (map.getSource('openaip')) return
  map.addSource('openaip', {
    type: 'vector',
    tiles: [`https://api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.pbf?apiKey=${OPENAIP_KEY}`],
    minzoom: 0, maxzoom: 14,
  })
  const add = (id, type, srcLayer, filter, paint, layout = {}) =>
    map.addLayer({ id, type, source: 'openaip', 'source-layer': srcLayer, filter, paint, layout })

  add('airspace-ctr-fill',    'fill',   'airspaces', ['==', ['get','type'], 'ctr'],                                              { 'fill-color': 'rgba(220,50,50,0.03)' })
  add('airspace-ctr-line',    'line',   'airspaces', ['==', ['get','type'], 'ctr'],                                              { 'line-color': 'rgba(220,50,50,0.9)', 'line-width': 2, 'line-dasharray': [4,2] })
  add('airspace-tma-fill',    'fill',   'airspaces', ['in', ['get','type'], ['literal',['tma','cta']]],                          { 'fill-color': 'rgba(0,0,0,0)' })
  add('airspace-tma-line',    'line',   'airspaces', ['in', ['get','type'], ['literal',['tma','cta']]],                          { 'line-color': 'rgba(30,100,220,0.85)', 'line-width': 1.5 })
  add('airspace-danger-fill', 'fill',   'airspaces', ['in', ['get','type'], ['literal',['danger','restricted','prohibited']]],   { 'fill-color': 'rgba(0,0,0,0)' })
  add('airspace-danger-line', 'line',   'airspaces', ['in', ['get','type'], ['literal',['danger','restricted','prohibited']]],   { 'line-color': 'rgba(255,140,0,0.9)', 'line-width': 1.5, 'line-dasharray': [3,2] })
  add('airports',             'circle', 'airports',  ['literal', true],                                                          { 'circle-radius': 5, 'circle-color': '#1a3a6b', 'circle-stroke-width': 2, 'circle-stroke-color': '#fff' })
  add('airports-labels',      'symbol', 'airports',  ['literal', true],
    { 'text-color': '#1a3a6b', 'text-halo-color': '#fff', 'text-halo-width': 1.5 },
    { 'text-field': ['get','icao_code'], 'text-font': ['Open Sans Bold','Arial Unicode MS Bold'], 'text-size': 10, 'text-offset': [0,1.4], 'text-anchor': 'top' }
  )
  const f = getAirportFilter(activeAirportTypes)
  map.setFilter('airports', f)
  map.setFilter('airports-labels', f)
}

// (23/09, retours Christophe) VISIBILITÉ DES TRACES SUR TOUS LES FONDS.
// Constat : le traitillé gris du vol à venir (#6b7280 à 55 %) se perdait sur les fonds
// chargés, et la trace parcourue « en blanc » — en fait la phase GROUND, roulage — devenait
// invisible dès qu'on passait sur une carte claire.
// Remède conforme à la charte : on ne change aucune couleur de la palette, on ajoute sous
// chaque trace un LISERÉ (casing) de contraste OPPOSÉ — technique cartographique classique.
// Le liseré n'est pas décoratif : c'est lui qui garantit la lecture sur clair, sur satellite
// et sur relief, sans introduire de couleur hors charte.
//   · vol à venir  : traitillé ENCRE sur ruban blanc  → lisible sur sombre ET sur clair
//   · vol parcouru : couleur de phase sur liseré ENCRE, sauf la phase CRITICAL (déjà encre)
//                    qui reçoit un liseré BLANC — d'où un liseré choisi par segment.
function addTraceLayers(map) {
  const round = { 'line-join': 'round', 'line-cap': 'round' }
  if (!map.getSource('ghost-trace')) {
    map.addSource('ghost-trace', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } })
    map.addLayer({ id: 'ghost-trace-casing', type: 'line', source: 'ghost-trace',
      layout: round,
      paint:  { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.55 },
    })
    map.addLayer({ id: 'ghost-trace', type: 'line', source: 'ghost-trace',
      layout: round,
      paint:  { 'line-color': T.ink, 'line-width': 2, 'line-opacity': 0.8, 'line-dasharray': [2.5, 2] },
    })
  }
  if (!map.getSource('played-trace')) {
    map.addSource('played-trace', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map.addLayer({ id: 'played-trace-casing', type: 'line', source: 'played-trace',
      layout: round,
      paint:  { 'line-color': ['get', 'casing'], 'line-width': 7, 'line-opacity': 0.9 },
    })
    map.addLayer({ id: 'played-trace', type: 'line', source: 'played-trace',
      layout: round,
      paint:  { 'line-color': ['get', 'color'], 'line-width': 4, 'line-opacity': 1 },
    })
  }
}

function applyTerrain(map) {
  if (!map.getSource('terrain-dem')) {
    map.addSource('terrain-dem', {
      type: 'raster-dem',
      url:  `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${MAPTILER_KEY}`,
      tileSize: 256,
    })
  }
  // exaggeration 1.0 = altitudes visuelles = altitudes réelles DEM
  // CRITIQUE : avec 1.5x, le terrain visuel dépasse la caméra = rentrée dans le sol
  map.setTerrain({ source: 'terrain-dem', exaggeration: 1.0 })
}

function applyFog(map) {
  try {
    map.setFog({
      color:            'rgb(210, 235, 255)',
      'high-color':     'rgb(25, 90, 200)',
      'horizon-blend':  0.08,
      'space-color':    'rgb(10, 40, 140)',
      'star-intensity': 0.0,
    })
  } catch (_) {}
}

/**
 * Crée le marker HTML pour l'avion.
 * SVG chargé via <img> — le navigateur rasterise le SVG nativement.
 * map.loadImage ne supporte pas les SVG (format raster WebGL uniquement).
 */
function createAircraftMarker(isDark = false) {
  const el = document.createElement('div')
  el.style.cssText = 'width:36px;height:36px;pointer-events:none;'
  const img = document.createElement('img')
  img.src   = '/icons/VL3.svg'
  img.style.cssText = `width:100%;height:100%;display:block;${isDark ? 'filter:invert(1) brightness(1.2);' : ''}`
  el.appendChild(img)
  return new maplibregl.Marker({ element: el, rotationAlignment: 'map' })
}

// ─── UI HELPERS ──────────────────────────────────────────────────────────────

// (22/09) Habillage AirKi, identique au panneau LAYERS de Live : encre, bord 1 px #2C2C2C, rayon 6, aucune ombre.
const panelStyle = {
  background: T.ink, borderRadius: 6, border: `1px solid ${T.ruleDark}`, overflow: 'hidden', width: 212,
}
const titleStyle = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '10px 12px', cursor: 'pointer', userSelect: 'none',
}
const titleText = labelStyle(T.mutedDark)
const Tri = ({ open }) => (
  <span style={{ display: 'flex', color: T.etch, transform: open ? 'rotate(90deg)' : 'none' }}><Icon name="chevron-right" size={16} /></span>
)

// Curseur : piste 4 px #2C2C2C, remplissage couleur, poignée blanche 12 px (déclaré au niveau module).
function SliderRow({ value, min = 0, max = 30, step = 1, color, onChange, label }) {
  const pct = ((value - min) / (max - min)) * 100
  return (
    <div style={{ position: 'relative', height: 12, display: 'flex', alignItems: 'center' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, height: 4, background: T.ruleDark, borderRadius: 999 }} />
      <div style={{ position: 'absolute', left: 0, width: `${pct}%`, height: 4, background: color, borderRadius: 999 }} />
      <div style={{ position: 'absolute', left: `calc(${pct}% - 6px)`, width: 12, height: 12, borderRadius: 999, background: T.white, pointerEvents: 'none' }} />
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label} className="ak-focus" onChange={e => onChange(Number(e.target.value))}
        style={{ position: 'absolute', width: '100%', opacity: 0, cursor: 'pointer', height: 12, margin: 0 }} />
    </div>
  )
}
const rowText = (on) => ({ fontFamily: T.sans, fontSize: 12, color: on ? T.white : T.mutedDark, cursor: 'pointer', userSelect: 'none' })
const swatch = (on, color, rgb, op) => ({ width: 10, height: 10, borderRadius: 2, flexShrink: 0,
  border: `1.5px solid ${on ? color : T.etch}`, background: on ? `rgba(${rgb},${Math.max(0.15, (op ?? 0) / 30)})` : 'transparent' })

/**
 * Pre-cache les tuiles DEM et satellite en survolant silencieusement la route.
 * Appelé quand les frames sont chargées en mode 3D.
 * MapLibre charge les tuiles de chaque position visitée → déjà en cache pour le replay.
 */
function preCacheTiles(map, frames, targetZoom = 12) {
  if (!frames?.length || !map.isStyleLoaded()) return
  // 25 points clés répartis sur la route
  const keyFrames = subsampleFrames(frames, 25)
  let i = 0
  const step = () => {
    if (i >= keyFrames.length) {
      // Fin du pre-cache : revenir à la vue globale
      const lons = frames.map(x => x.lon), lats = frames.map(x => x.lat)
      map.fitBounds(
        [[Math.min(...lons) - 0.1, Math.min(...lats) - 0.1],
         [Math.max(...lons) + 0.1, Math.max(...lats) + 0.1]],
        { padding: 40, duration: 600 }
      )
      return
    }
    const f = keyFrames[i++]
    // jumpTo = instantané → pas d'effet visuel, charge juste les tuiles
    map.jumpTo({ center: [f.lon, f.lat], zoom: targetZoom })
    // 80ms entre chaque point = temps de déclencher le fetch sans bloquer
    setTimeout(step, 80)
  }
  step()
}

// ─── COMPOSANT PRINCIPAL ─────────────────────────────────────────────────────

export default function ReplayMap({
  frames,
  currentFrame,
  is3D      = false,
  isPlaying = false,
  speed     = 1,
}) {
  const mapRef    = useRef(null)
  const mapObj    = useRef(null)
  const markerRef = useRef(null)
  const framesRef = useRef(frames)
  framesRef.current = frames

  // Smoothing refs (pas de state = pas de re-render React inutile)
  const hdgBufRef  = useRef([])   // buffer caps pour moyenne circulaire
  const smoothAgl  = useRef(null) // AGL lissé EMA — initialisé seulement quand DEM chargé
  const prevBrg    = useRef(null) // bearing caméra précédent (lissé)
  const prevZoom   = useRef(null) // zoom précédent (lissé)
  const brgEmaRef  = useRef(null) // pré-filtre EMA sur bearing brut GPS

  // UI state
  const [cockpitMode,  setCockpitMode]  = useState(true)
  const [zoomOffset,   setZoomOffset]   = useState(1.0) // zoom visual offset (-2 wide → +3 close)
  const [cockpitPitch, setCockpitPitch] = useState(72)  // degrees
  const [activeBasemap,  setActiveBasemap]  = useState('outdoor-v2')
  const [visible,        setVisible]        = useState({ ctr: true, tma: true, danger: true, airports: true })
  const [opacity,        setOpacity]        = useState({ ctr: 3, tma: 0, danger: 0 })
  const [activeAirports, setActiveAirports] = useState(['fixed'])
  const [panelOpen,      setPanelOpen]      = useState({ layers: true, map: false })

  // ── Init carte ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || mapObj.current) return

    const map = new maplibregl.Map({
      container: mapRef.current,
      style:     `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`,
      center:    [10.0, 60.5],
      zoom:      6,
      pitch:     0,
      maxPitch:  85,
      antialias: true,
    })
    mapObj.current = map

    // Créer le marker avion — SVG via <img>, pas de WebGL
    markerRef.current = createAircraftMarker(false)

    map.on('load', () => {
      addOpenAIPLayers(map, activeAirports)
      addTraceLayers(map)
      const f = framesRef.current
      if (f?.length) _fitBounds(map, f)
    })

    return () => {
      markerRef.current?.remove()
      map.remove()
      mapObj.current = null
    }
  }, [])

  // ── Fit bounds helper ───────────────────────────────────────────────────────
  function _fitBounds(map, f) {
    const lons = f.map(x => x.lon), lats = f.map(x => x.lat)
    map.fitBounds(
      [[Math.min(...lons) - 0.1, Math.min(...lats) - 0.1],
       [Math.max(...lons) + 0.1, Math.max(...lats) + 0.1]],
      { padding: 40, maxZoom: 12 }
    )
  }

  // ── Frames chargées ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!frames?.length) return
    const map = mapObj.current
    if (!map) return
    const apply = () => {
      addTraceLayers(map)
      _updateGhostTrace(map, frames)
      if (is3D) {
        preCacheTiles(map, frames, 12)
      } else {
        _fitBounds(map, frames)
      }
    }
    if (map.isStyleLoaded()) apply(); else map.once('load', apply)
  }, [frames])

  // ── Réaction is3D ───────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapObj.current
    if (!map) return
    // Reset smoothing à chaque changement de mode
    hdgBufRef.current = []; smoothAgl.current = null
    prevBrg.current   = null; prevZoom.current = null
    brgEmaRef.current = null

    const applyMode = () => {
      if (is3D) {
        applyTerrain(map)
        applyFog(map)
        const f = currentFrame ?? framesRef.current?.[0]
        if (f) {
          map.easeTo({ center: [f.lon, f.lat], bearing: f.bearing ?? f.hdg ?? 0, pitch: cockpitPitch, zoom: 11, duration: 1200 })
        }
        // Pre-cache les tuiles de la route
        const allFrames = framesRef.current
        if (allFrames?.length) {
          setTimeout(() => preCacheTiles(map, allFrames, 12), 1500)
        }
        // Masquer le marker en cockpit, afficher en free
        if (markerRef.current?.getElement()) {
          markerRef.current.getElement().style.display = cockpitMode ? 'none' : ''
        }
      } else {
        // Retour 2D : supprimer terrain, revenir à la vue globale du vol
        try { if (map.getTerrain()) map.setTerrain(null) } catch (_) {}
        // Toujours afficher le marker
        if (markerRef.current?.getElement()) markerRef.current.getElement().style.display = ''
        // Reset pitch + bearing + recentrer sur le vol
        const f = framesRef.current
        if (f?.length) {
          const lons = f.map(x => x.lon), lats = f.map(x => x.lat)
          map.fitBounds(
            [[Math.min(...lons) - 0.1, Math.min(...lats) - 0.1],
             [Math.max(...lons) + 0.1, Math.max(...lats) + 0.1]],
            { padding: 40, pitch: 0, bearing: 0, maxZoom: 12, duration: 800 }
          )
        } else {
          map.easeTo({ pitch: 0, bearing: 0, zoom: 7, duration: 800 })
        }
      }
    }
    if (map.isStyleLoaded()) applyMode(); else map.once('load', applyMode)
  }, [is3D])

  // ── Changement basemap ──────────────────────────────────────────────────────
  const changeBasemap = useCallback((styleId) => {
    const map = mapObj.current
    if (!map) return
    setActiveBasemap(styleId)
    const isDark = DARK_MAPS.has(styleId)

    // Mettre à jour la couleur du marker
    if (markerRef.current) {
      markerRef.current.remove()
      markerRef.current = createAircraftMarker(isDark)
      const f = framesRef.current?.[0]
      if (f && map) {
        markerRef.current.setLngLat([f.lon, f.lat]).setRotation(f.hdg ?? 0).addTo(map)
      }
    }

    map.setStyle(`https://api.maptiler.com/maps/${styleId}/style.json?key=${MAPTILER_KEY}`)
    map.once('styledata', () => {
      addOpenAIPLayers(map, activeAirports)
      addTraceLayers(map)
      if (is3D) { applyTerrain(map); applyFog(map) }
      const f = framesRef.current
      if (f?.length) _updateGhostTrace(map, f)
    })
  }, [activeAirports, is3D, cockpitMode])

  // ── Layer toggles ────────────────────────────────────────────────────────────
  const toggleLayer = (id) => {
    const next = { ...visible, [id]: !visible[id] }
    setVisible(next)
    const map = mapObj.current
    ;(LAYER_IDS[id] || []).forEach(lid => {
      if (map?.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', next[id] ? 'visible' : 'none')
    })
  }
  const handleOpacity = (id, val) => {
    setOpacity(p => ({ ...p, [id]: val }))
    const fillId = `airspace-${id}-fill`
    if (mapObj.current?.getLayer(fillId)) mapObj.current.setPaintProperty(fillId, 'fill-color', FILL_COLORS[id](val / 100))
  }
  const toggleAirportType = (typeId) => {
    const next = activeAirports.includes(typeId)
      ? activeAirports.filter(t => t !== typeId)
      : [...activeAirports, typeId]
    setActiveAirports(next)
    const f = getAirportFilter(next)
    if (mapObj.current?.getLayer('airports')) mapObj.current.setFilter('airports', f)
    if (mapObj.current?.getLayer('airports-labels')) mapObj.current.setFilter('airports-labels', f)
  }

  // ── Ghost trace helper ───────────────────────────────────────────────────────
  function _updateGhostTrace(map, f) {
    const src = map.getSource('ghost-trace')
    if (!src) return
    const sub = subsampleFrames(f, 3000)
    src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: sub.map(x => [x.lon, x.lat]) } })
  }

  // ── Effet principal : caméra + traces ────────────────────────────────────────
  useEffect(() => {
    const map = mapObj.current
    if (!map || !currentFrame) return

    const { lon, lat, hdg = 0, bearing, altGps, altInd, phase, agl } = currentFrame

    // ════════════════════════════════════════════════════════════════
    //  2D MODE
    // ════════════════════════════════════════════════════════════════
    if (!is3D) {
      // Caméra suit l'avion quand replay en cours
      if (isPlaying) {
        const frameInterval = 1000 / speed
        const dur = Math.max(16, frameInterval * 0.75)
        map.easeTo({
          center:   [lon, lat],
          pitch:    0,
          bearing:  0,
          duration: dur,
          easing:   t => t,
        })
      }
      // Marker : toujours mis à jour (même en pause)
      if (markerRef.current) {
        markerRef.current.setLngLat([lon, lat]).setRotation(bearing ?? hdg)
        if (!markerRef.current._map) markerRef.current.addTo(map)
        markerRef.current.getElement().style.display = ''
      }

    // ════════════════════════════════════════════════════════════════
    //  3D COCKPIT MODE
    // ════════════════════════════════════════════════════════════════
    } else if (cockpitMode) {

      // ── 1. Altitude MSL de l'œil pilote ─────────────────────────────────────
      const altGpsM = (altGps ?? altInd ?? 1000) * 0.3048

      // ── 2. AGL lissé — terrain null guard ───────────────────────────────────
      // queryTerrainElevation retourne null si les tuiles DEM ne sont pas encore chargées.
      // On n'initialise smoothAgl QUE quand on a des données terrain réelles pour éviter
      // le snap brutal à l'arrivée des tuiles.
      const terrainH  = map.queryTerrainElevation?.([lon, lat]) ?? null
      const onGround  = phase === 'GROUND'
      if (terrainH !== null) {
        const rawAgl = altGpsM - terrainH
        const target = (onGround || rawAgl < 20) ? 4 : Math.max(20, rawAgl)
        if (smoothAgl.current === null) {
          smoothAgl.current = target
        } else {
          const alpha = Math.abs(target - smoothAgl.current) > 100 ? 0.18 : 0.10
          smoothAgl.current += (target - smoothAgl.current) * alpha
        }
      }
      // Fallback si tuiles pas encore chargées : estimation à 50% de l'altitude GPS.
      // Reste stable si smoothAgl est déjà initialisé (terrainH temporairement absent).
      const aglM = smoothAgl.current ?? Math.max(20, altGpsM * 0.5)

      // ── 3. Bearing : TRK GPS prioritaire, HDG en fallback ───────────────────
      const rawBrg = bearing ?? hdg

      if (brgEmaRef.current === null) brgEmaRef.current = rawBrg
      const emaDiff = (((rawBrg - brgEmaRef.current + 540) % 360) - 180)
      brgEmaRef.current = ((brgEmaRef.current + emaDiff * 0.5 + 360) % 360)

      const buf = hdgBufRef.current
      buf.push(brgEmaRef.current)
      if (buf.length > 8) buf.shift()

      const recentBuf   = buf.slice(-3)
      const recentDelta = recentBuf.length >= 2
        ? Math.abs((((recentBuf[recentBuf.length - 1] - recentBuf[0] + 540) % 360) - 180))
        : 0
      const isTurning = recentDelta > 1.5

      const meanBrg = isTurning ? circularMean(buf.slice(-3)) : circularMean(buf)
      const prev    = prevBrg.current ?? meanBrg
      const delta   = Math.abs((((meanBrg - prev + 540) % 360) - 180))

      const deadZone   = isTurning ? 0.5 : 2.0
      const lerpFactor = isTurning ? 0.50 : 0.25
      const newBrg = delta < deadZone
        ? prev
        : prev + (((meanBrg - prev + 540) % 360) - 180) * lerpFactor
      prevBrg.current = ((newBrg % 360) + 360) % 360

      // ── 4. Caméra hybride ────────────────────────────────────────────────────
      // L'API calcule le CENTER correct (point de regard pour la position pilote + pitch).
      // On OVERRIDES le zoom avec log2(C/AGL) : cette échelle correspond exactement
      // à ce que perçoit visuellement un pilote à cette altitude AGL.
      // L'API pure retourne un zoom 1.7 niveaux trop bas (terrain 3× trop petit).
      const camOpts = map.calculateCameraOptionsFromCameraLngLatAltRotation(
        [lon, lat],
        Math.max(1, altGpsM),
        prevBrg.current,
        cockpitPitch,
        0
      )

      const rawZoom    = Math.log2(1638400 / aglM) + zoomOffset
      const targetZoom = Math.max(8, Math.min(18, rawZoom))
      const pz         = prevZoom.current ?? targetZoom
      const newZoom    = Math.abs(targetZoom - pz) < 0.05 ? pz : pz + (targetZoom - pz) * 0.15
      prevZoom.current = newZoom

      // ── 5. Animation ─────────────────────────────────────────────────────────
      const frameInterval = 1000 / speed
      const dur = Math.max(16, frameInterval * 0.85)
      map.easeTo({ ...camOpts, zoom: newZoom, duration: dur, easing: t => t })

      if (markerRef.current?.getElement()) markerRef.current.getElement().style.display = 'none'

    // ════════════════════════════════════════════════════════════════
    //  3D FREE MODE
    // ════════════════════════════════════════════════════════════════
    } else {
      if (isPlaying) {
        const dur = Math.max(100, Math.round(500 / speed))
        map.easeTo({ center: [lon, lat], duration: dur })
      }
      // Marker visible en free
      if (markerRef.current) {
        markerRef.current.setLngLat([lon, lat]).setRotation(hdg)
        if (!markerRef.current._map) markerRef.current.addTo(map)
        markerRef.current.getElement().style.display = ''
      }
    }

    // ── Mise à jour sources GeoJSON (traces) ──────────────────────
    if (!frames || !map.isStyleLoaded()) return

    // Ghost trace (futur, grisé)
    _updateGhostTrace(map, frames)

    // Played trace (passé, coloré par phase)
    const played = frames.filter(f => f.ts <= currentFrame.ts)
    const sub    = subsampleFrames(played, 2000)
    const features = []
    if (sub.length > 1) {
      let coords = [[sub[0].lon, sub[0].lat]], curPhase = sub[0].phase
      for (let i = 1; i < sub.length; i++) {
        coords.push([sub[i].lon, sub[i].lat])
        if (sub[i].phase !== curPhase || i === sub.length - 1) {
          if (coords.length >= 2)
            features.push({
              type: 'Feature',
              properties: (() => {
                const color = PHASE_COLORS[curPhase] ?? T.ok
                // liseré opposé : encre sous une couleur claire, blanc sous l'encre
                return { color, casing: color === T.ink ? '#ffffff' : T.ink }
              })(),
              geometry: { type: 'LineString', coordinates: [...coords] },
            })
          coords = [[sub[i].lon, sub[i].lat]]
          curPhase = sub[i].phase
        }
      }
    }
    const traceSrc = map.getSource('played-trace')
    if (traceSrc) traceSrc.setData({ type: 'FeatureCollection', features })

  }, [currentFrame, frames, is3D, isPlaying, cockpitMode, zoomOffset, cockpitPitch, speed])

  // ─── RENDER ─────────────────────────────────────────────────────────────────

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>

      {/* Fond bleu CSS — visible en 3D au-dessus du terrain */}
      <div ref={mapRef} style={{
        width: '100%', height: '100%',
        background: 'linear-gradient(to bottom, #0a2a8a 0%, #1a5cbf 25%, #4a90d9 55%, #87c8f0 80%, #d0eaff 100%)',
      }} />

      {/* ── Panel gauche (AIP + MAP) ── */}
      <div style={{ position: 'absolute', top: 46, left: 10, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>

        {/* AIP LAYERS */}
        <div style={panelStyle}>
          <div style={titleStyle} onClick={() => setPanelOpen(p => ({ ...p, layers: !p.layers }))}>
            <span style={titleText}>AIP LAYERS</span>
            <Tri open={panelOpen.layers} />
          </div>
          {panelOpen.layers && (
            <div style={{ padding: 12, borderTop: `1px solid ${T.ruleDark}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {LAYERS.filter(l => l.id !== 'airports').map(layer => {
                const on = visible[layer.id]
                return (
                  <div key={layer.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div onClick={() => toggleLayer(layer.id)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span aria-hidden="true" style={swatch(on, layer.color, layer.rgb, opacity[layer.id])} />
                        <span style={rowText(on)}>{layer.label}</span>
                      </span>
                      {layer.hasSlider && on && <span style={monoStyle(11, T.mutedDark)}>{opacity[layer.id]}%</span>}
                    </div>
                    {layer.hasSlider && on && (
                      <SliderRow value={opacity[layer.id]} max={30} color={layer.color} label={`${layer.label} shading`} onChange={v => handleOpacity(layer.id, v)} />
                    )}
                  </div>
                )
              })}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div onClick={() => toggleLayer('airports')} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <span aria-hidden="true" style={swatch(visible.airports, '#4a7ab5', '74,122,181', 30)} />
                  <span style={rowText(visible.airports)}>Airports</span>
                </div>
                {visible.airports && AIRPORT_TYPES.map(t => {
                  const checked = activeAirports.includes(t.id)
                  return (
                    <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 18, cursor: 'pointer', userSelect: 'none' }}>
                      <input type="checkbox" className="ak-focus" checked={checked} onChange={() => toggleAirportType(t.id)}
                        style={{ appearance: 'none', WebkitAppearance: 'none', margin: 0, width: 10, height: 10, borderRadius: 2, cursor: 'pointer',
                                 border: `1.5px solid ${checked ? T.white : T.etch}`, background: checked ? T.white : 'transparent' }} />
                      <span style={{ ...rowText(checked), fontSize: 11 }}>{t.label}</span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* MAP */}
        <div style={panelStyle}>
          <div style={titleStyle} onClick={() => setPanelOpen(p => ({ ...p, map: !p.map }))}>
            <span style={titleText}>MAP</span>
            <Tri open={panelOpen.map} />
          </div>
          {panelOpen.map && (
            <div role="radiogroup" aria-label="Map type" style={{ padding: 12, borderTop: `1px solid ${T.ruleDark}`, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
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
          )}
        </div>
      </div>

      {/* ── Panel droit (controls 3D + légende phases) ── */}
      <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>

        {/* Bouton COCKPIT / FREE */}
        {is3D && (
          <button onClick={() => {
            setCockpitMode(v => !v)
            // Reset smoothing au switch
            hdgBufRef.current = []; smoothAgl.current = null
            prevBrg.current   = null; prevZoom.current = null
            brgEmaRef.current = null
          }} className="ak-focus" aria-pressed={cockpitMode} title={cockpitMode ? 'Camera follows the aircraft' : 'Free camera'} style={{
            background:    cockpitMode ? T.white : T.ink,
            color:         cockpitMode ? T.ink : T.white,
            border:        `1px solid ${cockpitMode ? T.white : T.ruleDark}`,
            borderRadius:  4, padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6,
            fontFamily:    T.mono, fontSize: 11, fontWeight: 500,
            letterSpacing: '0.08em', cursor: 'pointer', userSelect: 'none',
          }}>
            <Icon name={cockpitMode ? 'plane' : 'map'} size={16} />{cockpitMode ? 'COCKPIT' : 'FREE'}
          </button>
        )}

        {/* Sliders cockpit */}
        {is3D && cockpitMode && (
          <div style={{ background: T.ink, border: `1px solid ${T.ruleDark}`, borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 14, width: 180 }}>
            {/* Zoom visuel : 0 = échelle terrain = altitude AGL réelle */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={labelStyle(T.mutedDark)}>VIEW</span>
                <span style={monoStyle(11, T.white)}>{zoomOffset > 0 ? '+' : ''}{zoomOffset.toFixed(2)}</span>
              </div>
              <SliderRow value={zoomOffset} min={-2} max={3} step={0.25} color={T.etch} label="Camera distance" onChange={v => { setZoomOffset(v); prevZoom.current = null }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                <span style={labelStyle(T.etch)}>WIDE</span><span style={labelStyle(T.etch)}>CLOSE</span>
              </div>
            </div>
            {/* Angle de la caméra */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={labelStyle(T.mutedDark)}>ANGLE</span>
                <span style={monoStyle(11, T.white)}>{cockpitPitch}°</span>
              </div>
              <SliderRow value={cockpitPitch} min={60} max={85} step={1} color={T.etch} label="Camera angle" onChange={v => setCockpitPitch(v)} />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                <span style={labelStyle(T.etch)}>OBLIQUE</span><span style={labelStyle(T.etch)}>HORIZON</span>
              </div>
            </div>
          </div>
        )}

        {/* Légende phases */}
        <div style={{ background: T.ink, borderRadius: 6, padding: '10px 12px', border: `1px solid ${T.ruleDark}`, display: 'flex', flexDirection: 'column', gap: 7 }}>
          <span style={labelStyle(T.mutedDark)}>FLIGHT PHASE</span>
          {Object.entries(PHASE_COLORS).filter(([p]) => p !== 'GROUND').map(([phase, color]) => (
            <div key={phase} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 16, height: 3, background: color, outline: color === T.ink ? `1px solid ${T.etch}` : 'none' }} />
              <span style={{ fontFamily: T.sans, fontSize: 12, color: T.white }}>{PHASE_LABELS[phase]}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
