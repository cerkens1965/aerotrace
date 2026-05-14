import { useEffect, useRef, useState, useCallback } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import useSafeSky from '../../hooks/useSafeSky'
import { AtCoreMarkerLayer } from '../live/AtCoreMarkerLayer'

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY
const OPENAIP_KEY = import.meta.env.VITE_OPENAIP_KEY
const CENTER = { lat: 50.9014, lon: 4.4844 }
const ALT_MAX = 35000

const BASEMAPS = [
  { id: 'dataviz-light', label: 'Light' },
  { id: 'dataviz-dark',  label: 'Dark' },
  { id: 'outdoor-v2',    label: 'Topo' },
  { id: 'satellite',     label: 'Satellite' },
  { id: 'basic-v2',      label: 'Basic' },
]

const AIRPORT_TYPES = [
  { id: 'fixed', label: 'ADEP / ULM / MIL' },
  { id: 'heli',  label: 'HÉLIPAD' },
  { id: 'sea',   label: 'HYDRAVION' },
]

const LAYERS = [
  { id: 'ctr',      label: 'CTR',      color: '#dc3232', rgb: '220,50,50',  hasSlider: true,  hasAltSlider: false },
  { id: 'tma',      label: 'TMA/CTA',  color: '#1e64dc', rgb: '30,100,220', hasSlider: true,  hasAltSlider: false },
  { id: 'danger',   label: 'DANGER',   color: '#ff8c00', rgb: '255,140,0',  hasSlider: true,  hasAltSlider: false },
  { id: 'airports', label: 'AIRPORTS', color: '#4a7ab5', rgb: '74,122,181', hasSlider: false, hasAltSlider: false },
  { id: 'traffic',  label: 'TRAFFIC',  color: '#00cc66', rgb: '0,204,102',  hasSlider: false, hasAltSlider: true  },
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
  if (ft <= 0) return 'GND'
  if (ft >= ALT_MAX) return 'FL350+'
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

function addOpenAIPLayers(map, activeAirportTypes) {
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

  map.addLayer({ id: 'airports', type: 'circle', source: 'openaip', 'source-layer': 'airports', paint: { 'circle-radius': 5, 'circle-color': '#1a3a6b', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' } })
  map.addLayer({ id: 'airports-labels', type: 'symbol', source: 'openaip', 'source-layer': 'airports', layout: { 'text-field': ['get', 'icao_code'], 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-size': 10, 'text-offset': [0, 1.4], 'text-anchor': 'top' }, paint: { 'text-color': '#1a3a6b', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 } })
  const f = getAirportFilter(activeAirportTypes)
  map.setFilter('airports', f)
  map.setFilter('airports-labels', f)
}

function SliderTrack({ value, max = 30, color, onChange }) {
  return (
    <div style={{ position: 'relative', height: 10, display: 'flex', alignItems: 'center' }}>
      <div style={{ position: 'absolute', width: '100%', height: 1, background: 'rgba(255,255,255,0.08)', borderRadius: 1 }} />
      <div style={{ position: 'absolute', width: `${(value / max) * 100}%`, height: 1, background: color, borderRadius: 1 }} />
      <div style={{ position: 'absolute', left: `calc(${(value / max) * 100}% - 4px)`, width: 8, height: 8, borderRadius: '50%', background: color, pointerEvents: 'none' }} />
      <input type="range" min={0} max={max} step={max === ALT_MAX ? 1000 : 1} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ position: 'absolute', width: '100%', opacity: 0, cursor: 'pointer', height: 10, margin: 0, background: 'transparent', WebkitAppearance: 'none', appearance: 'none' }} />
    </div>
  )
}

export default function AerotraceMap() {
  const mapContainer = useRef(null)
  const map = useRef(null)
  const markersRef = useRef({})
  const traffic = useSafeSky(CENTER)
  const [activeBasemap, setActiveBasemap] = useState('dataviz-light')
  const [visible, setVisible] = useState({ ctr: true, tma: true, danger: true, airports: true, traffic: true })
  const [opacity, setOpacity] = useState({ ctr: 3, tma: 0, danger: 0 })
  const [activeAirports, setActiveAirports] = useState(['fixed'])
  const [altRange, setAltRange] = useState([0, ALT_MAX])
  const [panelOpen, setPanelOpen] = useState({ layers: true, map: false })
  const [mapReady, setMapReady] = useState(false)

  const filteredTraffic = traffic.filter(ac => {
    const alt = ac.altitude || 0
    return alt >= altRange[0] && alt <= altRange[1]
  })

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
    map.current.once('styledata', () => addOpenAIPLayers(map.current, activeAirports))
  }, [activeAirports])

  useEffect(() => {
    if (map.current) return
    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: `https://api.maptiler.com/maps/dataviz-light/style.json?key=${MAPTILER_KEY}`,
      center: [CENTER.lon, CENTER.lat],
      zoom: 9,
    })
    map.current.addControl(new maplibregl.NavigationControl(), 'top-right')
    map.current.on('load', () => { addOpenAIPLayers(map.current, activeAirports); setMapReady(true) })
    return () => { map.current?.remove(); map.current = null }
  }, [])

  useEffect(() => {
    if (!map.current) return
    Object.values(markersRef.current).forEach(m => m.remove())
    markersRef.current = {}
    if (!visible.traffic) return
    const isDark = activeBasemap === 'dataviz-dark' || activeBasemap === 'satellite'
    const labelBg   = isDark ? 'rgba(0,0,0,0.72)'          : 'rgba(255,255,255,0.65)'
    const labelBdr  = isDark ? '1px solid rgba(255,255,255,0.25)' : '1px solid rgba(0,0,0,0.5)'
    const labelClr  = isDark ? '#fff'                       : '#111'
    const iconFilter = isDark ? 'invert(1)'                 : 'none'
    filteredTraffic.forEach(ac => {
      const el = document.createElement('div')
      el.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;cursor:pointer;">
          <img src="/icons/VL3.svg" style="width:32px;height:32px;transform:rotate(${ac.course || 0}deg);transform-origin:center center;filter:${iconFilter};" />
          <div style="margin-top:2px;background:${labelBg};border:${labelBdr};border-radius:4px;padding:1px 5px;text-align:center;white-space:nowrap;font-family:monospace;line-height:1.2;">
            <div style="font-size:10px;font-weight:700;color:${labelClr};">${ac.call_sign || ac.id}</div>
            <div style="font-size:9px;font-weight:400;color:${labelClr};">${ac.altitude || 0} ft</div>
          </div>
        </div>`
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([ac.longitude, ac.latitude])
        .setPopup(new maplibregl.Popup({ offset: 25 }).setHTML(`
          <div style="font-family:monospace;font-size:12px;line-height:1.6;">
            <b>${ac.call_sign || ac.id}</b><br/>
            Type: ${ac.beacon_type}<br/>
            Alt: ${ac.altitude} ft<br/>
            Spd: ${ac.ground_speed} kt<br/>
            Hdg: ${ac.course}°<br/>
            Status: ${ac.status}
          </div>`))
        .addTo(map.current)
      markersRef.current[ac.id] = marker
    })
  }, [filteredTraffic, visible.traffic, activeBasemap])

  const panel = { background: 'rgba(5,8,20,0.82)', borderRadius: 10, border: '0.5px solid rgba(255,255,255,0.08)', overflow: 'hidden' }
  const titleStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', cursor: 'pointer', userSelect: 'none' }
  const titleText = { fontSize: 10, fontWeight: 700, fontFamily: 'monospace', letterSpacing: '0.15em', color: 'rgba(255,255,255,0.9)' }
  const triangle = (open) => (
    <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.4)', display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}>▶</span>
  )


  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
      {mapReady && <AtCoreMarkerLayer map={map.current} />}

      <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', flexDirection: 'column', gap: 4, zIndex: 10, minWidth: 172 }}>

        {/* AIP LAYERS */}
        <div style={panel}>
          <div style={titleStyle} onClick={() => setPanelOpen(p => ({ ...p, layers: !p.layers }))}>
            <span style={titleText}>AIP LAYERS</span>
            {triangle(panelOpen.layers)}
          </div>
          {panelOpen.layers && (
            <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {LAYERS.map(layer => {
                const on = visible[layer.id]
                const hasContent = on && (layer.hasSlider || layer.hasAltSlider || layer.id === 'airports')
                return (
                  <div key={layer.id}>
                    <div onClick={() => toggleLayer(layer.id)} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '4px 6px', borderRadius: hasContent ? '6px 6px 0 0' : 6,
                      background: on ? `rgba(${layer.rgb},0.1)` : 'rgba(255,255,255,0.02)',
                      borderLeft: `2px solid ${on ? layer.color : 'rgba(255,255,255,0.07)'}`,
                      cursor: 'pointer', userSelect: 'none',
                    }}>
                      <span style={{ fontSize: 9, fontWeight: 500, fontFamily: 'monospace', letterSpacing: '0.05em', color: on ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.55)' }}>
                        {layer.label}
                      </span>
                      <span style={{ fontSize: 8, color: on ? layer.color : 'rgba(255,255,255,0.35)', fontFamily: 'monospace' }}>
                        {layer.hasSlider && on && `${opacity[layer.id]}%`}
                        {layer.hasAltSlider && on && `${filteredTraffic.length} ✈ · ${formatAlt(altRange[0])}·${formatAlt(altRange[1])}`}
                      </span>
                    </div>

                    {layer.hasSlider && on && (
                      <div onClick={e => e.stopPropagation()} style={{ padding: '4px 6px 5px', background: 'rgba(5,8,20,0.7)', borderLeft: `2px solid ${layer.color}`, borderRadius: '0 0 6px 6px' }}>
                        <SliderTrack value={opacity[layer.id]} max={30} color={layer.color} onChange={v => handleOpacity(layer.id, v)} />
                      </div>
                    )}

                    {layer.id === 'airports' && on && (
                      <div onClick={e => e.stopPropagation()} style={{ padding: '5px 6px 6px', background: 'rgba(5,8,20,0.7)', borderLeft: `2px solid ${layer.color}`, borderRadius: '0 0 6px 6px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {AIRPORT_TYPES.map(t => {
                          const checked = activeAirports.includes(t.id)
                          return (
                            <div key={t.id} onClick={() => toggleAirportType(t.id)} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none' }}>
                              <div style={{ width: 8, height: 8, borderRadius: 2, border: `1.5px solid ${checked ? layer.color : 'rgba(255,255,255,0.2)'}`, background: checked ? layer.color : 'transparent', flexShrink: 0, transition: 'all 0.15s' }} />
                              <span style={{ fontSize: 9, fontFamily: 'monospace', color: checked ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.6)' }}>{t.label}</span>
                            </div>
                          )
                        })}
                      </div>
                    )}

                    {layer.hasAltSlider && on && (
                      <div onClick={e => e.stopPropagation()} style={{ padding: '5px 6px 6px', background: 'rgba(5,8,20,0.7)', borderLeft: `2px solid ${layer.color}`, borderRadius: '0 0 6px 6px' }}>
                        {[0, 1].map(idx => (
                          <div key={idx} style={{ marginBottom: idx === 0 ? 5 : 0 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                              <span style={{ fontSize: 8, color: 'rgba(255,255,255,0.55)', fontFamily: 'monospace' }}>{idx === 0 ? 'MIN' : 'MAX'}</span>
                              <span style={{ fontSize: 8, color: layer.color, fontFamily: 'monospace' }}>{formatAlt(altRange[idx])}</span>
                            </div>
                            <SliderTrack value={altRange[idx]} max={ALT_MAX} color={layer.color}
                              onChange={v => setAltRange(prev => idx === 0
                                ? [Math.min(v, prev[1] - 1000), prev[1]]
                                : [prev[0], Math.max(v, prev[0] + 1000)])} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
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
            <div style={{ padding: '0 8px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
              {BASEMAPS.map(bm => (
                <div key={bm.id} onClick={() => changeBasemap(bm.id)} style={{
                  padding: '4px 6px', borderRadius: 6, cursor: 'pointer',
                  background: activeBasemap === bm.id ? 'rgba(255,255,255,0.08)' : 'transparent',
                  borderLeft: `2px solid ${activeBasemap === bm.id ? 'rgba(255,255,255,0.4)' : 'transparent'}`,
                }}>
                  <span style={{ fontSize: 9, fontFamily: 'monospace', fontWeight: 500, letterSpacing: '0.05em', color: activeBasemap === bm.id ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.55)' }}>
                    {bm.label.toUpperCase()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}
