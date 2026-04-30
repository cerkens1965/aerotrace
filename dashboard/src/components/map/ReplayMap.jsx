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
  { id: 'tma',      label: 'TMA/CTA',  color: '#1e64dc', rgb: '30,100,220', hasSlider: true  },
  { id: 'danger',   label: 'DANGER',   color: '#ff8c00', rgb: '255,140,0',  hasSlider: true  },
  { id: 'airports', label: 'AIRPORTS', color: '#4a7ab5', rgb: '74,122,181', hasSlider: false },
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
  { id: 'fixed', label: 'ADEP / ULM / MIL' },
  { id: 'heli',  label: 'HÉLIPAD'           },
  { id: 'sea',   label: 'HYDRAVION'         },
]

const PHASE_COLORS = {
  GROUND:   '#ffffff',
  CRUISE:   '#22c55e',
  MANEUVER: '#f97316',
  APPROACH: '#F5A623',
  CRITICAL: '#ef4444',
}

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

/** Zoom MapLibre depuis altitude AGL en mètres */
function aglToZoom(aglM, offsetSlider = 12) {
  const m   = Math.max(2, aglM)
  const z   = Math.log2(1638400 / m)
  const off = (offsetSlider - 12) * 0.5
  return Math.max(8, Math.min(18, z + off))
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

function addTraceLayers(map) {
  if (!map.getSource('ghost-trace')) {
    map.addSource('ghost-trace', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } })
    map.addLayer({ id: 'ghost-trace', type: 'line', source: 'ghost-trace',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint:  { 'line-color': '#6b7280', 'line-width': 2, 'line-opacity': 0.55, 'line-dasharray': [4, 2] },
    })
  }
  if (!map.getSource('played-trace')) {
    map.addSource('played-trace', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map.addLayer({ id: 'played-trace', type: 'line', source: 'played-trace',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint:  { 'line-color': ['get', 'color'], 'line-width': 5, 'line-opacity': 1 },
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
  try {
    if (map.getLayer('sky')) map.removeLayer('sky')
    map.addLayer({ id: 'sky', type: 'sky', paint: {
      'sky-type': 'atmosphere',
      'sky-atmosphere-sun': [0, 60],
      'sky-atmosphere-sun-intensity': 8,
    }})
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

const panelStyle = {
  background: 'rgba(5,8,20,0.85)',
  borderRadius: 10,
  border: '0.5px solid rgba(255,255,255,0.08)',
  overflow: 'hidden',
}
const titleStyle = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '7px 10px', cursor: 'pointer', userSelect: 'none',
}
const titleText = {
  fontSize: 10, fontWeight: 700, fontFamily: 'monospace',
  letterSpacing: '0.15em', color: '#ffffff',
}
const Tri = ({ open }) => (
  <span style={{
    fontSize: 8, color: 'rgba(255,255,255,0.4)', display: 'inline-block',
    transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s',
  }}>▶</span>
)

function SliderRow({ label, value, max = 30, color, onChange }) {
  const pct = (value / max) * 100
  return (
    <div style={{ position: 'relative', height: 10, display: 'flex', alignItems: 'center' }}>
      <div style={{ position: 'absolute', width: '100%', height: 1, background: 'rgba(255,255,255,0.08)', borderRadius: 1 }} />
      <div style={{ position: 'absolute', width: `${pct}%`, height: 1, background: color, borderRadius: 1 }} />
      <div style={{ position: 'absolute', left: `calc(${pct}% - 4px)`, width: 8, height: 8, borderRadius: '50%', background: color, pointerEvents: 'none' }} />
      <input type="range" min={0} max={max} step={1} value={value} onChange={e => onChange(Number(e.target.value))}
        style={{ position: 'absolute', width: '100%', opacity: 0, cursor: 'pointer', height: 10, margin: 0, WebkitAppearance: 'none' }} />
    </div>
  )
}

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
  const smoothAgl  = useRef(null) // AGL lissé EMA
  const prevBrg    = useRef(null) // bearing précédent
  const prevZoom   = useRef(null) // zoom précédent

  // UI state
  const [cockpitMode,  setCockpitMode]  = useState(true)
  const [cockpitZoom,  setCockpitZoom]  = useState(12)  // offset slider
  const [cockpitPitch, setCockpitPitch] = useState(72)  // degrés
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
        // Pre-cache les tuiles terrain avant de jouer
        preCacheTiles(map, frames, Math.round(aglToZoom(500, cockpitZoom)))
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
          setTimeout(() => preCacheTiles(map, allFrames, Math.round(aglToZoom(500, cockpitZoom))), 1500)
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
        markerRef.current.setLngLat([lon, lat]).setRotation(hdg)
        if (!markerRef.current._map) markerRef.current.addTo(map)
        markerRef.current.getElement().style.display = ''
      }

    // ════════════════════════════════════════════════════════════════
    //  3D COCKPIT MODE
    // ════════════════════════════════════════════════════════════════
    } else if (cockpitMode) {

      // 1. Vrai AGL = AltGPS(m MSL) − terrain(m MSL)
      //    queryTerrainElevation avec exaggeration=1.0 retourne les mètres réels
      const altGpsM    = ((altGps ?? altInd ?? 1000) * 0.3048)
      const terrainM   = map.queryTerrainElevation?.([lon, lat]) ?? 0
      const rawAglM    = altGpsM - terrainM
      const onGround   = phase === 'GROUND' || rawAglM < 20
      const targetAglM = onGround ? 4 : Math.max(20, rawAglM)

      // 2. Lissage AGL (EMA α=0.1) — lent, évite sauts altimètre ±5ft
      if (smoothAgl.current === null) smoothAgl.current = targetAglM
      const alpha = onGround ? 0.6 : 0.10           // très lent en croisière
      smoothAgl.current += (targetAglM - smoothAgl.current) * alpha
      const aglM = smoothAgl.current

      // 3. Bearing = TRK (GPS vrai) ou HDG+MagVar
      const rawBrg = bearing ?? hdg

      // 4. Lissage bearing adaptatif :
      //    - En croisière (cap stable) : buffer 8 frames + dead zone 3° + lerp 20%
      //    - En virage (cap change > 1°/frame) : buffer 3 frames + dead zone 0° + lerp 50%
      const buf = hdgBufRef.current
      buf.push(rawBrg)
      if (buf.length > 8) buf.shift()

      // Détecter si on vire : comparer les 3 dernières valeurs brutes
      const recentBuf = buf.slice(-3)
      const recentDelta = recentBuf.length >= 2
        ? Math.abs(((recentBuf[recentBuf.length-1] - recentBuf[0] + 540) % 360) - 180)
        : 0
      const isTurning = recentDelta > 1.5   // > 1.5° en 3s = virage réel

      const meanBrg = isTurning
        ? circularMean(buf.slice(-3))        // en virage : moyenne 3 frames seulement
        : circularMean(buf)                  // stable : moyenne 8 frames

      const prev    = prevBrg.current ?? meanBrg
      const delta   = Math.abs(((meanBrg - prev + 540) % 360) - 180)
      const deadZone = isTurning ? 0.5 : 3.0
      const lerpFactor = isTurning ? 0.5 : 0.20
      const newBrg  = delta < deadZone
        ? prev
        : prev + (((meanBrg - prev + 540) % 360) - 180) * lerpFactor
      prevBrg.current = newBrg

      // 5. Zoom lissé (seuil 5% strict — ne bouge pas si AGL stable)
      const targetZoom = aglToZoom(aglM, cockpitZoom)
      const pz         = prevZoom.current ?? targetZoom
      const zDelta     = Math.abs(targetZoom - pz) / Math.max(0.5, Math.abs(pz))
      const newZoom    = zDelta < 0.05              // seuil 5%
        ? pz
        : pz + (targetZoom - pz) * 0.15            // lerp 15% (très lent)
      prevZoom.current = newZoom

      // 6. Centre = point devant l'avion (œil pilote)
      const pitchRad = cockpitPitch * Math.PI / 180
      const aheadKm  = Math.max(0.01, Math.min(15, aglM * Math.tan(pitchRad) / 1000))
      const center   = getAheadPoint(lon, lat, newBrg, aheadKm)

      // 7. Animation — CRITIQUE : duration < intervalle entre frames (1000/speed)
      //    Si trop long → MapLibre interrompt l'animation → snapback → effet yo-yo
      const frameInterval = 1000 / speed           // ms entre deux frames
      const dur = Math.max(16, frameInterval * 0.75) // 75% de l'intervalle max
      map.easeTo({
        center,
        bearing:  newBrg,
        pitch:    cockpitPitch,
        zoom:     newZoom,
        duration: dur,
        easing:   t => t,                           // linéaire = pas de rebond
      })

      // Marker caché (on est dans le cockpit)
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
              properties: { color: PHASE_COLORS[curPhase] ?? '#22c55e' },
              geometry: { type: 'LineString', coordinates: [...coords] },
            })
          coords = [[sub[i].lon, sub[i].lat]]
          curPhase = sub[i].phase
        }
      }
    }
    const traceSrc = map.getSource('played-trace')
    if (traceSrc) traceSrc.setData({ type: 'FeatureCollection', features })

  }, [currentFrame, frames, is3D, isPlaying, cockpitMode, cockpitZoom, cockpitPitch, speed])

  // ─── RENDER ─────────────────────────────────────────────────────────────────

  const zPct = ((cockpitZoom - 8) / 8) * 100
  const pPct = ((cockpitPitch - 60) / 25) * 100

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
            <div style={{ padding: '0 8px 8px' }}>
              {LAYERS.filter(l => l.id !== 'airports').map(layer => {
                const on = visible[layer.id]
                return (
                  <div key={layer.id} style={{ marginBottom: 6, borderLeft: `2px solid ${on ? layer.color : 'rgba(255,255,255,0.1)'}`, padding: '4px 6px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: layer.hasSlider && on ? 4 : 0 }}>
                      <span onClick={() => toggleLayer(layer.id)} style={{ fontSize: 9, fontFamily: 'monospace', color: on ? '#fff' : 'rgba(255,255,255,0.4)', cursor: 'pointer', userSelect: 'none' }}>
                        {layer.label}
                      </span>
                      {layer.hasSlider && on && <span style={{ fontSize: 8, color: layer.color, fontFamily: 'monospace' }}>{opacity[layer.id]}%</span>}
                    </div>
                    {layer.hasSlider && on && (
                      <SliderRow value={opacity[layer.id]} max={30} color={layer.color} onChange={v => handleOpacity(layer.id, v)} />
                    )}
                  </div>
                )
              })}
              {/* Airports */}
              <div style={{ borderLeft: `2px solid ${visible.airports ? '#4a7ab5' : 'rgba(255,255,255,0.1)'}`, paddingLeft: 6 }}>
                <span onClick={() => toggleLayer('airports')} style={{ fontSize: 9, fontWeight: 700, fontFamily: 'monospace', color: visible.airports ? '#fff' : 'rgba(255,255,255,0.4)', cursor: 'pointer', display: 'block', marginBottom: 4 }}>
                  AIRPORTS
                </span>
                {visible.airports && AIRPORT_TYPES.map(t => {
                  const checked = activeAirports.includes(t.id)
                  return (
                    <div key={t.id} onClick={() => toggleAirportType(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, cursor: 'pointer' }}>
                      <div style={{ width: 10, height: 10, border: `1px solid ${checked ? '#4a7ab5' : 'rgba(255,255,255,0.3)'}`, borderRadius: 2, background: checked ? '#4a7ab5' : 'transparent', flexShrink: 0 }} />
                      <span style={{ fontSize: 9, fontFamily: 'monospace', color: '#fff' }}>{t.label}</span>
                    </div>
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
            <div style={{ padding: '0 8px 8px' }}>
              {BASEMAPS.map(bm => (
                <div key={bm.id} onClick={() => changeBasemap(bm.id)} style={{
                  padding: '4px 6px', cursor: 'pointer', borderRadius: 4, marginBottom: 2,
                  background:  activeBasemap === bm.id ? 'rgba(245,166,35,0.1)' : 'transparent',
                  borderLeft: `2px solid ${activeBasemap === bm.id ? '#F5A623' : 'transparent'}`,
                }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 9, fontWeight: 500, color: '#fff' }}>{bm.label}</span>
                </div>
              ))}
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
          }} style={{
            background:    cockpitMode ? '#F5A623' : 'rgba(5,8,20,0.85)',
            color:         cockpitMode ? '#050814' : '#fff',
            border:        `1px solid ${cockpitMode ? '#F5A623' : 'rgba(255,255,255,0.15)'}`,
            borderRadius:  6, padding: '5px 12px',
            fontFamily:    'monospace', fontSize: 10, fontWeight: 700,
            letterSpacing: '0.1em', cursor: 'pointer', userSelect: 'none',
          }}>
            {cockpitMode ? '✈ COCKPIT' : '🗺 FREE'}
          </button>
        )}

        {/* Sliders cockpit */}
        {is3D && cockpitMode && (
          <div style={{ background: 'rgba(5,8,20,0.88)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 10, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 10, width: 160 }}>
            <style>{`
              .ct-sl { -webkit-appearance:none; appearance:none; width:100%; height:6px; border-radius:3px; outline:none; cursor:pointer; }
              .ct-sl::-webkit-slider-thumb { -webkit-appearance:none; width:20px; height:20px; border-radius:50%; cursor:pointer; border:2px solid #050814; }
              .ct-z { background: linear-gradient(to right, #F5A623 0%, #F5A623 ${zPct}%, rgba(255,255,255,0.12) ${zPct}%); }
              .ct-z::-webkit-slider-thumb { background: #F5A623; }
              .ct-p { background: linear-gradient(to right, #22c55e 0%, #22c55e ${pPct}%, rgba(255,255,255,0.12) ${pPct}%); }
              .ct-p::-webkit-slider-thumb { background: #22c55e; }
            `}</style>

            {/* Slider altitude (offset zoom) */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>ALTITUDE</span>
                <span style={{ fontFamily: 'monospace', fontSize: 8, color: '#F5A623' }}>{cockpitZoom > 12 ? '+' : ''}{(cockpitZoom - 12).toFixed(0)}</span>
              </div>
              <input type="range" className="ct-sl ct-z" min={8} max={16} step={0.5} value={cockpitZoom}
                onChange={e => { setCockpitZoom(Number(e.target.value)); prevZoom.current = null }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 7, color: 'rgba(255,255,255,0.25)' }}>HAUT</span>
                <span style={{ fontFamily: 'monospace', fontSize: 7, color: 'rgba(255,255,255,0.25)' }}>BAS</span>
              </div>
            </div>

            {/* Slider angle pitch */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 8, color: 'rgba(255,255,255,0.5)' }}>ANGLE</span>
                <span style={{ fontFamily: 'monospace', fontSize: 8, color: '#22c55e' }}>{cockpitPitch}°</span>
              </div>
              <input type="range" className="ct-sl ct-p" min={60} max={85} step={1} value={cockpitPitch}
                onChange={e => { const p = Number(e.target.value); setCockpitPitch(p); mapObj.current?.easeTo({ pitch: p, duration: 200 }) }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}>
                <span style={{ fontFamily: 'monospace', fontSize: 7, color: 'rgba(255,255,255,0.25)' }}>OBLIQUE</span>
                <span style={{ fontFamily: 'monospace', fontSize: 7, color: 'rgba(255,255,255,0.25)' }}>HORIZON</span>
              </div>
            </div>
          </div>
        )}

        {/* Légende phases */}
        <div style={{ background: 'rgba(5,8,20,0.85)', borderRadius: 8, padding: '8px 10px', border: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {Object.entries(PHASE_COLORS).filter(([p]) => p !== 'GROUND').map(([phase, color]) => (
            <div key={phase} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 16, height: 3, background: color, borderRadius: 1 }} />
              <span style={{ fontFamily: 'monospace', fontSize: 7, color: '#fff' }}>{phase}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
