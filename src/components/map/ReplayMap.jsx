import { useEffect, useRef, useState, useCallback } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { subsampleFrames } from '../../utils/csvParser'

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY
const OPENAIP_KEY  = import.meta.env.VITE_OPENAIP_KEY

// ── Same basemaps as LIVE ─────────────────────────────────────────────────────
const BASEMAPS = [
  { id: 'dataviz-light', label: 'Light',     dark: false },
  { id: 'dataviz-dark',  label: 'Dark',      dark: true  },
  { id: 'outdoor-v2',    label: 'Topo',      dark: false },
  { id: 'satellite',     label: 'Satellite', dark: true  },
  { id: 'basic-v2',      label: 'Basic',     dark: false },
]

// ── Same AIP layers as LIVE (minus traffic) ───────────────────────────────────
const LAYERS = [
  { id: 'ctr',      label: 'CTR',      color: '#dc3232', rgb: '220,50,50',  hasSlider: true  },
  { id: 'tma',      label: 'TMA/CTA',  color: '#1e64dc', rgb: '30,100,220', hasSlider: true  },
  { id: 'danger',   label: 'DANGER',   color: '#ff8c00', rgb: '255,140,0',  hasSlider: true  },
  { id: 'airports', label: 'AIRPORTS', color: '#4a7ab5', rgb: '74,122,181', hasSlider: false },
]

const LAYER_IDS = {
  ctr:      ['airspace-ctr-fill', 'airspace-ctr-line'],
  tma:      ['airspace-tma-fill', 'airspace-tma-line'],
  danger:   ['airspace-danger-fill', 'airspace-danger-line'],
  airports: ['airports', 'airports-labels'],
}

const FILL_COLORS = {
  ctr:    o => `rgba(220,50,50,${o})`,
  tma:    o => `rgba(30,100,220,${o})`,
  danger: o => `rgba(255,140,0,${o})`,
}

const AIRPORT_TYPES = [
  { id: 'fixed', label: 'ADEP / ULM / MIL' },
  { id: 'heli',  label: 'HÉLIPAD' },
  { id: 'sea',   label: 'HYDRAVION' },
]

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
  map.addSource('openaip', { type: 'vector',
    tiles: [`https://api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.pbf?apiKey=${OPENAIP_KEY}`],
    minzoom: 0, maxzoom: 14 })
  map.addLayer({ id: 'airspace-ctr-fill',    type: 'fill',   source: 'openaip', 'source-layer': 'airspaces', filter: ['==', ['get', 'type'], 'ctr'],                                                                                 paint: { 'fill-color': 'rgba(220,50,50,0.03)' } })
  map.addLayer({ id: 'airspace-ctr-line',    type: 'line',   source: 'openaip', 'source-layer': 'airspaces', filter: ['==', ['get', 'type'], 'ctr'],                                                                                 paint: { 'line-color': 'rgba(220,50,50,0.9)',  'line-width': 2,   'line-dasharray': [4,2] } })
  map.addLayer({ id: 'airspace-tma-fill',    type: 'fill',   source: 'openaip', 'source-layer': 'airspaces', filter: ['in', ['get', 'type'], ['literal', ['tma','cta']]],                                                           paint: { 'fill-color': 'rgba(0,0,0,0)' } })
  map.addLayer({ id: 'airspace-tma-line',    type: 'line',   source: 'openaip', 'source-layer': 'airspaces', filter: ['in', ['get', 'type'], ['literal', ['tma','cta']]],                                                           paint: { 'line-color': 'rgba(30,100,220,0.85)', 'line-width': 1.5 } })
  map.addLayer({ id: 'airspace-danger-fill', type: 'fill',   source: 'openaip', 'source-layer': 'airspaces', filter: ['in', ['get', 'type'], ['literal', ['danger','restricted','prohibited']]],                                    paint: { 'fill-color': 'rgba(0,0,0,0)' } })
  map.addLayer({ id: 'airspace-danger-line', type: 'line',   source: 'openaip', 'source-layer': 'airspaces', filter: ['in', ['get', 'type'], ['literal', ['danger','restricted','prohibited']]],                                    paint: { 'line-color': 'rgba(255,140,0,0.9)',  'line-width': 1.5, 'line-dasharray': [3,2] } })
  map.addLayer({ id: 'airports',             type: 'circle', source: 'openaip', 'source-layer': 'airports',  paint: { 'circle-radius': 5, 'circle-color': '#1a3a6b', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' } })
  map.addLayer({ id: 'airports-labels',      type: 'symbol', source: 'openaip', 'source-layer': 'airports',
    layout: { 'text-field': ['get', 'icao_code'], 'text-font': ['Open Sans Bold','Arial Unicode MS Bold'], 'text-size': 10, 'text-offset': [0,1.4], 'text-anchor': 'top' },
    paint:  { 'text-color': '#1a3a6b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } })
  const f = getAirportFilter(activeAirportTypes)
  map.setFilter('airports', f)
  map.setFilter('airports-labels', f)
}

// ── Phase colors ──────────────────────────────────────────────────────────────
const PHASE_COLORS = {
  GROUND: '#ffffff', CRUISE: '#22c55e', MANEUVER: '#f97316', APPROACH: '#F5A623', CRITICAL: '#ef4444',
}

function addTraceLayers(map) {
  if (!map.getSource('ghost-trace')) {
    map.addSource('ghost-trace', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] } } })
    map.addLayer({ id: 'ghost-trace', type: 'line', source: 'ghost-trace',
      paint: { 'line-color': '#999999', 'line-width': 2.5, 'line-opacity': 0.65 },
      layout: { 'line-join': 'round', 'line-cap': 'round' } })
  }
  if (!map.getSource('played-trace')) {
    map.addSource('played-trace', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map.addLayer({ id: 'played-trace', type: 'line', source: 'played-trace',
      paint: { 'line-color': ['get', 'color'], 'line-width': 6, 'line-opacity': 1 },
      layout: { 'line-join': 'round', 'line-cap': 'round' } })
  }
}

// ── UI helpers (identical to AerotraceMap) ────────────────────────────────────
const panel     = { background: 'rgba(5,8,20,0.82)', borderRadius: 10, border: '0.5px solid rgba(255,255,255,0.08)', overflow: 'hidden' }
const titleStyle = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '7px 10px', cursor: 'pointer', userSelect: 'none' }
const titleText  = { fontSize: 10, fontWeight: 700, fontFamily: 'monospace', letterSpacing: '0.15em', color: '#ffffff' }
const triangle   = (open) => <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>▶</span>

// ── Main component ────────────────────────────────────────────────────────────
function SliderTrack({ value, max = 30, color, onChange }) {
  return (
    <div style={{ position: 'relative', height: 10, display: 'flex', alignItems: 'center' }}>
      <div style={{ position: 'absolute', width: '100%', height: 1, background: 'rgba(255,255,255,0.08)', borderRadius: 1 }} />
      <div style={{ position: 'absolute', width: `${(value / max) * 100}%`, height: 1, background: color, borderRadius: 1 }} />
      <div style={{ position: 'absolute', left: `calc(${(value / max) * 100}% - 4px)`, width: 8, height: 8, borderRadius: '50%', background: color, pointerEvents: 'none' }} />
      <input type="range" min={0} max={max} step={1} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ position: 'absolute', width: '100%', opacity: 0, cursor: 'pointer', height: 10, margin: 0, background: 'transparent', WebkitAppearance: 'none', appearance: 'none' }} />
    </div>
  )
}

export default function ReplayMap({ frames, currentFrame, is3D = false }) {
  const mapRef      = useRef(null)
  const mapObj      = useRef(null)
  const markerRef   = useRef(null)
  const framesRef   = useRef(frames)
  framesRef.current = frames

  const [activeBasemap,  setActiveBasemap]  = useState('outdoor-v2')
  const [visible,        setVisible]        = useState({ ctr: true, tma: true, danger: true, airports: true })
  const [opacity,        setOpacity]        = useState({ ctr: 3, tma: 0, danger: 0 })
  const [activeAirports, setActiveAirports] = useState(['fixed'])
  const [panelOpen,      setPanelOpen]      = useState({ layers: true, map: false })
  const [showMap,        setShowMap]        = useState(false)

  // ── Init ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || mapObj.current) return
    const map = new maplibregl.Map({
      container: mapRef.current,
      style: `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`,
      center: [10.0, 60.5], zoom: 7, pitch: is3D ? 60 : 0, antialias: true,
    })
    mapObj.current = map

    const el = document.createElement('div')
    el.style.cssText = 'width:36px;height:36px;pointer-events:none;'
    el.innerHTML = '<img id="replay-aircraft-icon" src="/icons/VL3.svg" style="width:100%;height:100%;" />'

    map.on('load', () => {
      addOpenAIPLayers(map, activeAirports)
      addTraceLayers(map)
      markerRef.current = new maplibregl.Marker({ element: el, rotationAlignment: 'map' })
      const f = framesRef.current
      if (f && f.length > 0) {
        markerRef.current.setLngLat([f[0].lon, f[0].lat]).setRotation(f[0].hdg ?? 0).addTo(map)
        const src = map.getSource('ghost-trace')
        if (src) {
          const sub = subsampleFrames(f, 3000)
          src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: sub.map(x => [x.lon, x.lat]) } })
        }
        map.fitBounds([[Math.min(...f.map(x=>x.lon))-0.1, Math.min(...f.map(x=>x.lat))-0.1],
                       [Math.max(...f.map(x=>x.lon))+0.1, Math.max(...f.map(x=>x.lat))+0.1]], { padding: 40 })
      }
    })
    return () => { if (markerRef.current) markerRef.current.remove(); map.remove(); mapObj.current = null }
  }, [])

  // ── Frames loaded ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!frames || frames.length === 0) return
    const map = mapObj.current
    if (!map) return
    const apply = () => {
      if (markerRef.current) markerRef.current.setLngLat([frames[0].lon, frames[0].lat]).setRotation(frames[0].hdg ?? 0).addTo(map)
      addTraceLayers(map)
      const src = map.getSource('ghost-trace')
      if (src) {
        const sub = subsampleFrames(frames, 3000)
        src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: sub.map(f => [f.lon, f.lat]) } })
      }
      map.fitBounds([[Math.min(...frames.map(x=>x.lon))-0.1, Math.min(...frames.map(x=>x.lat))-0.1],
                     [Math.max(...frames.map(x=>x.lon))+0.1, Math.max(...frames.map(x=>x.lat))+0.1]], { padding: 40 })
    }
    if (map.isStyleLoaded()) apply(); else map.once('load', apply)
  }, [frames])

  // ── Basemap change ────────────────────────────────────────────────────────
  const changeBasemap = useCallback((styleId) => {
    const map = mapObj.current
    if (!map) return
    setActiveBasemap(styleId)
    map.setStyle(`https://api.maptiler.com/maps/${styleId}/style.json?key=${MAPTILER_KEY}`)
    map.once('styledata', () => {
      addOpenAIPLayers(map, activeAirports)
      addTraceLayers(map)
      const f = framesRef.current
      if (f && f.length > 0) {
        const sub = subsampleFrames(f, 3000)
        const src = map.getSource('ghost-trace')
        if (src) src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: sub.map(x => [x.lon, x.lat]) } })
      }
    })
    const dark = BASEMAPS.find(b => b.id === styleId)?.dark
    const icon = document.getElementById('replay-aircraft-icon')
    if (icon) icon.style.filter = dark ? 'invert(1)' : 'none'
  }, [activeAirports])

  // ── Layer toggle ──────────────────────────────────────────────────────────
  const toggleLayer = (id) => {
    const next = { ...visible, [id]: !visible[id] }
    setVisible(next)
    const map = mapObj.current
    if (!map) return
    ;(LAYER_IDS[id] || []).forEach(lid => {
      if (map.getLayer(lid)) map.setLayoutProperty(lid, 'visibility', next[id] ? 'visible' : 'none')
    })
  }

  const handleOpacity = (id, val) => {
    setOpacity(prev => ({ ...prev, [id]: val }))
    const map = mapObj.current
    const fillLayerId = `airspace-${id}-fill`
    if (map?.getLayer(fillLayerId)) map.setPaintProperty(fillLayerId, 'fill-color', FILL_COLORS[id](val / 100))
  }

  const toggleAirportType = (typeId) => {
    const next = activeAirports.includes(typeId) ? activeAirports.filter(t => t !== typeId) : [...activeAirports, typeId]
    setActiveAirports(next)
    const map = mapObj.current
    const f = getAirportFilter(next)
    if (map?.getLayer('airports')) map.setFilter('airports', f)
    if (map?.getLayer('airports-labels')) map.setFilter('airports-labels', f)
  }

  // ── Played trace + marker update ──────────────────────────────────────────
  useEffect(() => {
    const map = mapObj.current
    if (!map || !currentFrame || !frames) return
    if (markerRef.current) markerRef.current.setLngLat([currentFrame.lon, currentFrame.lat]).setRotation(currentFrame.hdg ?? 0).addTo(map)
    const doUpdate = () => {
      const played = frames.filter(f => f.ts <= currentFrame.ts)
      const sub = subsampleFrames(played, 2000)
      const features = []
      if (sub.length > 1) {
        let segCoords = [[sub[0].lon, sub[0].lat]], segPhase = sub[0].phase
        for (let i = 1; i < sub.length; i++) {
          segCoords.push([sub[i].lon, sub[i].lat])
          if (sub[i].phase !== segPhase || i === sub.length - 1) {
            if (segCoords.length >= 2) features.push({ type: 'Feature', properties: { color: PHASE_COLORS[segPhase] ?? '#22c55e' }, geometry: { type: 'LineString', coordinates: [...segCoords] } })
            segCoords = [[sub[i].lon, sub[i].lat]]; segPhase = sub[i].phase
          }
        }
      }
      const src = map.getSource('played-trace')
      if (src) src.setData({ type: 'FeatureCollection', features })
      if (is3D) map.easeTo({ center: [currentFrame.lon, currentFrame.lat], bearing: currentFrame.hdg ?? 0, pitch: 60, duration: 400 })
    }
    if (map.isStyleLoaded()) doUpdate(); else map.once('styledata', doUpdate)
  }, [currentFrame, frames, is3D])

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={mapRef} style={{ width: '100%', height: '100%' }} />

      {/* ── Left panel (AIP + MAP) — same as LIVE ── */}
      <div style={{ position: 'absolute', top: 46, left: 10, zIndex: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>

        {/* AIP LAYERS */}
        <div style={panel}>
          <div style={titleStyle} onClick={() => setPanelOpen(p => ({ ...p, layers: !p.layers }))}>
            <span style={titleText}>AIP LAYERS</span>
            {triangle(panelOpen.layers)}
          </div>
          {panelOpen.layers && (
            <div style={{ padding: '0 8px 8px' }}>
              {LAYERS.filter(l => l.id !== 'airports').map(layer => {
                const on = visible[layer.id]
                return (
                  <div key={layer.id} onClick={() => toggleLayer(layer.id)} style={{ marginBottom: 8, borderLeft: `2px solid ${on ? layer.color : 'rgba(255,255,255,0.1)'}`, paddingLeft: 6, borderRadius: '0 4px 4px 0', background: on ? `rgba(${layer.rgb},0.04)` : 'transparent', padding: '4px 6px', cursor: 'pointer' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: layer.hasSlider && on ? 4 : 0 }}>
                      <span style={{ fontSize: 9, fontWeight: 500, fontFamily: 'monospace', letterSpacing: '0.05em', color: on ? '#ffffff' : 'rgba(255,255,255,0.4)', userSelect: 'none' }}>{layer.label}</span>
                      {layer.hasSlider && on && <span style={{ fontSize: 8, color: layer.color, fontFamily: 'monospace' }}>{opacity[layer.id]}%</span>}
                    </div>
                    {layer.hasSlider && on && (
                      <SliderTrack value={opacity[layer.id]} max={30} color={layer.color} onChange={v => handleOpacity(layer.id, v)} />
                    )}
                  </div>
                )
              })}

              {/* AIRPORTS */}
              <div style={{ borderLeft: `2px solid ${visible.airports ? '#4a7ab5' : 'rgba(255,255,255,0.1)'}`, paddingLeft: 6, borderRadius: '0 4px 4px 0' }}>
                <span onClick={() => toggleLayer('airports')} style={{ fontSize: 9, fontWeight: 700, fontFamily: 'monospace', color: visible.airports ? '#ffffff' : 'rgba(255,255,255,0.4)', cursor: 'pointer', display: 'block', marginBottom: 4 }}>AIRPORTS</span>
                {visible.airports && AIRPORT_TYPES.map(t => {
                  const checked = activeAirports.includes(t.id)
                  return (
                    <div key={t.id} onClick={() => toggleAirportType(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2, cursor: 'pointer' }}>
                      <div style={{ width: 10, height: 10, border: `1px solid ${checked ? '#4a7ab5' : 'rgba(255,255,255,0.3)'}`, borderRadius: 2, background: checked ? '#4a7ab5' : 'transparent', flexShrink: 0 }} />
                      <span style={{ fontSize: 9, fontFamily: 'monospace', color: '#ffffff' }}>{t.label}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>

        {/* MAP */}
        <div style={panel}>
          <div style={titleStyle} onClick={() => setPanelOpen(p => ({ ...p, map: !p.map }))}>
            <span style={titleText}>MAP</span>
            {triangle(panelOpen.map)}
          </div>
          {panelOpen.map && (
            <div style={{ padding: '0 8px 8px' }}>
              {BASEMAPS.map(bm => (
                <div key={bm.id} onClick={() => changeBasemap(bm.id)} style={{
                  padding: '4px 6px', cursor: 'pointer', borderRadius: 4, marginBottom: 2,
                  background: activeBasemap === bm.id ? 'rgba(245,166,35,0.1)' : 'transparent',
                  borderLeft: `2px solid ${activeBasemap === bm.id ? '#F5A623' : 'transparent'}`,
                }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 9, fontWeight: 500, color: '#ffffff' }}>{bm.label}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Phase legend */}
      <div style={{ position: 'absolute', top: 10, right: 10, background: 'rgba(5,8,20,0.85)', borderRadius: 8, padding: '8px 10px', border: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {Object.entries(PHASE_COLORS).filter(([p]) => p !== 'GROUND').map(([phase, color]) => (
          <div key={phase} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 16, height: 3, background: color, borderRadius: 1 }} />
            <span style={{ fontFamily: 'monospace', fontSize: 7, color: '#ffffff' }}>{phase}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
