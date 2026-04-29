import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { subsampleFrames } from '../../utils/csvParser'

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY
const OPENAIP_KEY  = import.meta.env.VITE_OPENAIP_KEY

const BASEMAPS = [
  { id: 'outdoor',   label: 'TOPO',      dark: false },
  { id: 'satellite', label: 'SATELLITE', dark: true  },
  { id: 'light',     label: 'LIGHT',     dark: false },
  { id: 'dark',      label: 'DARK',      dark: true  },
  { id: 'basic',     label: 'BASIC',     dark: false },
]
const getStyleUrl = id => {
  const map = { outdoor: 'outdoor-v2', satellite: 'satellite', light: 'dataviz-light', dark: 'dataviz-dark', basic: 'basic-v2' }
  return `https://api.maptiler.com/maps/${map[id]}/style.json?key=${MAPTILER_KEY}`
}

const PHASE_COLORS = {
  GROUND:   '#ffffff', CRUISE:   '#22c55e',
  MANEUVER: '#f97316', APPROACH: '#F5A623', CRITICAL: '#ef4444',
}

const AIP_LAYERS = [
  { id: 'ctr',     label: 'CTR',     color: '#ef4444', types: [1,2,3]   },
  { id: 'tma',     label: 'TMA/CTA', color: '#3b82f6', types: [4,5]     },
  { id: 'danger',  label: 'DANGER',  color: '#f97316', types: [6,7,8,9] },
]

const AIRPORT_TYPES = [
  { id: 'civil', label: 'ADEP / ULM / MIL', codes: [0,2,3,9] },
  { id: 'heli',  label: 'HÉLIPAD',           codes: [5]        },
  { id: 'water', label: 'HYDRAVION',         codes: [7]        },
]

function setupBaseLayers(map) {
  if (!map.getSource('openaip')) {
    map.addSource('openaip', { type: 'vector',
      tiles: [`https://api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.pbf?apiKey=${OPENAIP_KEY}`],
      minzoom: 0, maxzoom: 14 })
  }
  // CTR
  if (!map.getLayer('ctr-fill')) {
    map.addLayer({ id: 'ctr-fill', type: 'fill', source: 'openaip', 'source-layer': 'airspaces',
      filter: ['==', ['get', 'type'], 'ctr'],
      paint: { 'fill-color': 'rgba(220,50,50,0.03)' } })
    map.addLayer({ id: 'ctr-line', type: 'line', source: 'openaip', 'source-layer': 'airspaces',
      filter: ['==', ['get', 'type'], 'ctr'],
      paint: { 'line-color': 'rgba(220,50,50,0.9)', 'line-width': 2, 'line-dasharray': [4,2] } })
  }
  // TMA
  if (!map.getLayer('tma-fill')) {
    map.addLayer({ id: 'tma-fill', type: 'fill', source: 'openaip', 'source-layer': 'airspaces',
      filter: ['in', ['get', 'type'], ['literal', ['tma','cta']]],
      paint: { 'fill-color': 'rgba(0,0,0,0)' } })
    map.addLayer({ id: 'tma-line', type: 'line', source: 'openaip', 'source-layer': 'airspaces',
      filter: ['in', ['get', 'type'], ['literal', ['tma','cta']]],
      paint: { 'line-color': 'rgba(30,100,220,0.85)', 'line-width': 1.5 } })
  }
  // DANGER
  if (!map.getLayer('danger-line')) {
    map.addLayer({ id: 'danger-fill', type: 'fill', source: 'openaip', 'source-layer': 'airspaces',
      filter: ['in', ['get', 'type'], ['literal', ['danger','restricted','prohibited']]],
      paint: { 'fill-color': 'rgba(0,0,0,0)' } })
    map.addLayer({ id: 'danger-line', type: 'line', source: 'openaip', 'source-layer': 'airspaces',
      filter: ['in', ['get', 'type'], ['literal', ['danger','restricted','prohibited']]],
      paint: { 'line-color': 'rgba(255,140,0,0.9)', 'line-width': 1.5, 'line-dasharray': [3,2] } })
  }
  // Airports
  if (!map.getLayer('airports')) {
    map.addLayer({ id: 'airports', type: 'circle', source: 'openaip', 'source-layer': 'airports',
      paint: { 'circle-radius': 5, 'circle-color': '#1e3a5f', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } })
    map.addLayer({ id: 'airport-labels', type: 'symbol', source: 'openaip', 'source-layer': 'airports',
      layout: { 'text-field': ['get', 'icao_code'], 'text-size': 10, 'text-offset': [0, 1.2], 'text-anchor': 'top' },
      paint: { 'text-color': '#ffffff', 'text-halo-color': '#000000', 'text-halo-width': 1 } })
  }
  // Traces
  if (!map.getSource('ghost-trace')) {
    map.addSource('ghost-trace', { type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } })
    map.addLayer({ id: 'ghost-trace', type: 'line', source: 'ghost-trace',
      paint: { 'line-color': '#999999', 'line-width': 2.5, 'line-opacity': 0.65 },
      layout: { 'line-join': 'round', 'line-cap': 'round' } })
  }
  if (!map.getSource('played-trace')) {
    map.addSource('played-trace', { type: 'geojson',
      data: { type: 'FeatureCollection', features: [] } })
    map.addLayer({ id: 'played-trace', type: 'line', source: 'played-trace',
      paint: { 'line-color': ['get', 'color'], 'line-width': 6, 'line-opacity': 1 },
      layout: { 'line-join': 'round', 'line-cap': 'round' } })
  }
}

function updateGhostTrace(map, frames) {
  if (!frames || frames.length === 0) return
  const sub = subsampleFrames(frames, 3000)
  const src = map.getSource('ghost-trace')
  if (src) src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: sub.map(f => [f.lon, f.lat]) } })
}

export default function ReplayMap({ frames, currentFrame, is3D = false }) {
  const mapRef     = useRef(null)
  const mapObj     = useRef(null)
  const markerRef  = useRef(null)
  const markerElRef = useRef(null)
  const framesRef  = useRef(frames)
  const [basemap,      setBasemap]      = useState('outdoor')
  const [showBasemaps, setShowBasemaps] = useState(false)
  const [aipOpen,      setAipOpen]      = useState(true)
  const [aipLayers,    setAipLayers]    = useState({ ctr: true, tma: true, danger: true })
  const [airports,     setAirports]     = useState(true)

  framesRef.current = frames

  // ── Init map ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || mapObj.current) return
    const map = new maplibregl.Map({
      container: mapRef.current,
      style: getStyleUrl('outdoor'),
      center: [10.0, 60.5],
      zoom: 7, pitch: is3D ? 60 : 0, antialias: true,
    })
    mapObj.current = map

    // Marker element
    const el = document.createElement('div')
    el.style.cssText = 'width:36px;height:36px;pointer-events:none;'
    el.innerHTML = '<img id="aircraft-icon" src="/icons/VL3.svg" style="width:100%;height:100%;" />'
    markerElRef.current = el

    map.on('load', () => {
      setupBaseLayers(map)
      markerRef.current = new maplibregl.Marker({ element: el, rotationAlignment: 'map' })

      // Place marker at start immediately
      const f = framesRef.current
      if (f && f.length > 0) {
        markerRef.current.setLngLat([f[0].lon, f[0].lat]).setRotation(f[0].hdg ?? 0).addTo(map)
        updateGhostTrace(map, f)
        map.fitBounds([[Math.min(...f.map(x=>x.lon))-0.1, Math.min(...f.map(x=>x.lat))-0.1],
                       [Math.max(...f.map(x=>x.lon))+0.1, Math.max(...f.map(x=>x.lat))+0.1]], { padding: 40 })
      }
    })

    return () => {
      if (markerRef.current) markerRef.current.remove()
      map.remove(); mapObj.current = null
    }
  }, [])

  // ── Place marker at start when frames load ──────────────────────────────────
  useEffect(() => {
    if (!frames || frames.length === 0) return
    const map = mapObj.current
    if (!map) return

    const place = () => {
      if (markerRef.current) {
        markerRef.current.setLngLat([frames[0].lon, frames[0].lat]).setRotation(frames[0].hdg ?? 0).addTo(map)
      }
      updateGhostTrace(map, frames)
      map.fitBounds([[Math.min(...frames.map(x=>x.lon))-0.1, Math.min(...frames.map(x=>x.lat))-0.1],
                     [Math.max(...frames.map(x=>x.lon))+0.1, Math.max(...frames.map(x=>x.lat))+0.1]], { padding: 40 })
    }

    if (map.isStyleLoaded()) place()
    else map.once('load', place)
  }, [frames])

  // ── Basemap change ──────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapObj.current
    if (!map) return
    map.setStyle(getStyleUrl(basemap))
    map.once('styledata', () => {
      setupBaseLayers(map)
      updateGhostTrace(map, framesRef.current)
      // Restore visibility
      applyLayerVisibility(map, aipLayers, airports)
    })
    // Icon color
    const icon = document.getElementById('aircraft-icon')
    const dark = BASEMAPS.find(b => b.id === basemap)?.dark
    if (icon) icon.style.filter = dark ? 'invert(1)' : 'none'
  }, [basemap])

  // ── AIP visibility ──────────────────────────────────────────────────────────
  function applyLayerVisibility(map, layers, apt) {
    const vis = (on) => on ? 'visible' : 'none'
    ;['ctr-fill','ctr-line'].forEach(l => { try { map.setLayoutProperty(l, 'visibility', vis(layers.ctr)) } catch(e){} })
    ;['tma-fill','tma-line'].forEach(l => { try { map.setLayoutProperty(l, 'visibility', vis(layers.tma)) } catch(e){} })
    ;['danger-fill','danger-line'].forEach(l => { try { map.setLayoutProperty(l, 'visibility', vis(layers.danger)) } catch(e){} })
    ;['airports','airport-labels'].forEach(l => { try { map.setLayoutProperty(l, 'visibility', vis(apt)) } catch(e){} })
  }

  useEffect(() => {
    const map = mapObj.current
    if (!map || !map.isStyleLoaded()) return
    applyLayerVisibility(map, aipLayers, airports)
  }, [aipLayers, airports])

  // ── Update played trace + marker ────────────────────────────────────────────
  useEffect(() => {
    const map = mapObj.current
    if (!map || !currentFrame || !frames) return

    if (markerRef.current) {
      markerRef.current.setLngLat([currentFrame.lon, currentFrame.lat]).setRotation(currentFrame.hdg ?? 0).addTo(map)
    }

    const doUpdate = () => {
      const played = frames.filter(f => f.ts <= currentFrame.ts)
      const sub = subsampleFrames(played, 2000)
      const features = []
      if (sub.length > 1) {
        let segCoords = [[sub[0].lon, sub[0].lat]], segPhase = sub[0].phase
        for (let i = 1; i < sub.length; i++) {
          segCoords.push([sub[i].lon, sub[i].lat])
          if (sub[i].phase !== segPhase || i === sub.length - 1) {
            if (segCoords.length >= 2) features.push({ type: 'Feature',
              properties: { color: PHASE_COLORS[segPhase] ?? '#22c55e' },
              geometry: { type: 'LineString', coordinates: [...segCoords] } })
            segCoords = [[sub[i].lon, sub[i].lat]]; segPhase = sub[i].phase
          }
        }
      }
      const src = map.getSource('played-trace')
      if (src) src.setData({ type: 'FeatureCollection', features })
      if (is3D) map.easeTo({ center: [currentFrame.lon, currentFrame.lat], bearing: currentFrame.hdg ?? 0, pitch: 60, duration: 400 })
    }

    if (map.isStyleLoaded()) doUpdate()
    else map.once('styledata', doUpdate)
  }, [currentFrame, frames, is3D])

  const toggleAip = (id) => setAipLayers(p => ({ ...p, [id]: !p[id] }))

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={mapRef} style={{ width: '100%', height: '100%' }} />

      {/* AIP Panel */}
      <div style={{ position: 'absolute', top: 10, left: 10, zIndex: 10,
        background: 'rgba(5,8,20,0.88)', borderRadius: 10, border: '0.5px solid rgba(255,255,255,0.07)',
        overflow: 'hidden', minWidth: 160 }}>
        <div onClick={() => setAipOpen(p => !p)} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '7px 10px', cursor: 'pointer' }}>
          <span style={{ fontFamily: 'monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.15em', color: '#ffffff' }}>AIP LAYERS</span>
          <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', transform: aipOpen ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>▶</span>
        </div>
        {aipOpen && (
          <div style={{ padding: '0 8px 8px' }}>
            {AIP_LAYERS.map(l => (
              <div key={l.id} onClick={() => toggleAip(l.id)} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '4px 4px', cursor: 'pointer', borderLeft: `2px solid ${aipLayers[l.id] ? l.color : 'rgba(255,255,255,0.1)'}`,
                paddingLeft: 6, marginBottom: 2, borderRadius: '0 4px 4px 0',
              }}>
                <span style={{ fontFamily: 'monospace', fontSize: 9, color: aipLayers[l.id] ? '#ffffff' : 'rgba(255,255,255,0.4)' }}>{l.label}</span>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: aipLayers[l.id] ? l.color : 'transparent',
                  border: `1.5px solid ${aipLayers[l.id] ? l.color : 'rgba(255,255,255,0.2)'}` }} />
              </div>
            ))}
            <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '4px 0' }} />
            <div onClick={() => setAirports(p => !p)} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '4px 4px', cursor: 'pointer', borderLeft: `2px solid ${airports ? '#93c5fd' : 'rgba(255,255,255,0.1)'}`,
              paddingLeft: 6, borderRadius: '0 4px 4px 0',
            }}>
              <span style={{ fontFamily: 'monospace', fontSize: 9, color: airports ? '#ffffff' : 'rgba(255,255,255,0.4)' }}>AIRPORTS</span>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: airports ? '#93c5fd' : 'transparent',
                border: `1.5px solid ${airports ? '#93c5fd' : 'rgba(255,255,255,0.2)'}` }} />
            </div>
          </div>
        )}
      </div>

      {/* Phase legend */}
      <div style={{ position: 'absolute', top: 10, right: 10,
        background: 'rgba(5,8,20,0.85)', borderRadius: 8, padding: '8px 10px',
        border: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {Object.entries(PHASE_COLORS).filter(([p]) => p !== 'GROUND').map(([phase, color]) => (
          <div key={phase} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 16, height: 3, background: color, borderRadius: 1 }} />
            <span style={{ fontFamily: 'monospace', fontSize: 7, color: '#ffffff' }}>{phase}</span>
          </div>
        ))}
      </div>

      {/* Basemap selector */}
      <div style={{ position: 'absolute', bottom: 36, left: 10, zIndex: 10 }}>
        <button onClick={() => setShowBasemaps(p => !p)} style={{
          padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
          fontFamily: 'monospace', fontSize: 9, fontWeight: 700,
          background: 'rgba(5,8,20,0.9)', border: '1px solid rgba(255,255,255,0.15)', color: '#ffffff' }}>
          MAP ▾
        </button>
        {showBasemaps && (
          <div style={{ position: 'absolute', bottom: 32, left: 0,
            background: 'rgba(5,8,20,0.95)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 8, overflow: 'hidden', minWidth: 110 }}>
            {BASEMAPS.map(bm => (
              <div key={bm.id} onClick={() => { setBasemap(bm.id); setShowBasemaps(false) }} style={{
                padding: '7px 12px', cursor: 'pointer', fontFamily: 'monospace', fontSize: 10, fontWeight: 700,
                color: basemap === bm.id ? '#F5A623' : '#ffffff',
                background: basemap === bm.id ? 'rgba(245,166,35,0.1)' : 'transparent',
                borderLeft: `2px solid ${basemap === bm.id ? '#F5A623' : 'transparent'}`,
              }}>{bm.label}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
