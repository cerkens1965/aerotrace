import { useEffect, useRef, useState, useCallback } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import useSafeSky from '../../hooks/useSafeSky'

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY
const OPENAIP_KEY = import.meta.env.VITE_OPENAIP_KEY
const CENTER = { lat: 50.85, lon: 4.35 }

const BASEMAPS = [
  { id: 'dataviz-light', label: 'Clair' },
  { id: 'dataviz-dark',  label: 'Sombre' },
  { id: 'outdoor-v2',    label: 'Topo' },
  { id: 'satellite',     label: 'Satellite' },
  { id: 'basic-v2',      label: 'Basic' },
]

const LAYERS = [
  { id: 'ctr',      label: 'CTR',        color: '#dc3232', rgb: '220,50,50',  hasSlider: true  },
  { id: 'tma',      label: 'TMA / CTA',  color: '#1e64dc', rgb: '30,100,220', hasSlider: true  },
  { id: 'danger',   label: 'DANGER',     color: '#ff8c00', rgb: '255,140,0',  hasSlider: true  },
  { id: 'airports', label: 'AÉRODROMES', color: '#4a7ab5', rgb: '74,122,181', hasSlider: false },
  { id: 'traffic',  label: 'TRAFIC',     color: '#00cc66', rgb: '0,204,102',  hasSlider: false },
]

const LAYER_IDS = {
  ctr:      ['airspace-ctr-fill', 'airspace-ctr-line'],
  tma:      ['airspace-tma-fill', 'airspace-tma-line'],
  danger:   ['airspace-danger-fill', 'airspace-danger-line'],
  airports: ['airports'],
}

const FILL_COLORS = {
  ctr:    (o) => `rgba(220,50,50,${o})`,
  tma:    (o) => `rgba(30,100,220,${o})`,
  danger: (o) => `rgba(255,140,0,${o})`,
}

function addOpenAIPLayers(map) {
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
  map.addLayer({ id: 'airports', type: 'circle', source: 'openaip', 'source-layer': 'airports', paint: { 'circle-radius': 6, 'circle-color': '#1a3a6b', 'circle-stroke-width': 2, 'circle-stroke-color': '#ffffff' } })
}

export default function AerotraceMap() {
  const mapContainer = useRef(null)
  const map = useRef(null)
  const markersRef = useRef({})
  const traffic = useSafeSky(CENTER)
  const [activeBasemap, setActiveBasemap] = useState('dataviz-light')
  const [visible, setVisible] = useState({ ctr: true, tma: true, danger: true, airports: true, traffic: true })
  const [opacity, setOpacity] = useState({ ctr: 3, tma: 0, danger: 0 })

  const toggleLayer = (id) => {
    const newVisible = { ...visible, [id]: !visible[id] }
    setVisible(newVisible)
    if (!map.current || id === 'traffic') return
    ;(LAYER_IDS[id] || []).forEach(lid => {
      if (map.current.getLayer(lid))
        map.current.setLayoutProperty(lid, 'visibility', newVisible[id] ? 'visible' : 'none')
    })
  }

  const handleOpacity = (id, val) => {
    setOpacity(prev => ({ ...prev, [id]: val }))
    if (!map.current) return
    const fillLayerId = `airspace-${id}-fill`
    if (map.current.getLayer(fillLayerId))
      map.current.setPaintProperty(fillLayerId, 'fill-color', FILL_COLORS[id](val / 100))
  }

  const changeBasemap = useCallback((styleId) => {
    if (!map.current) return
    setActiveBasemap(styleId)
    map.current.setStyle(`https://api.maptiler.com/maps/${styleId}/style.json?key=${MAPTILER_KEY}`)
    map.current.once('styledata', () => { addOpenAIPLayers(map.current) })
  }, [])

  useEffect(() => {
    if (map.current) return
    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: `https://api.maptiler.com/maps/dataviz-light/style.json?key=${MAPTILER_KEY}`,
      center: [CENTER.lon, CENTER.lat],
      zoom: 9,
    })
    map.current.addControl(new maplibregl.NavigationControl(), 'top-right')
    map.current.on('load', () => { addOpenAIPLayers(map.current) })
    return () => { map.current?.remove(); map.current = null }
  }, [])

  useEffect(() => {
    if (!map.current) return
    Object.values(markersRef.current).forEach(m => m.remove())
    markersRef.current = {}
    if (!visible.traffic) return
    traffic.forEach(ac => {
      const el = document.createElement('div')
      el.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;">
          <div style="width:12px;height:12px;background:#00cc66;border:2px solid white;border-radius:50%;"></div>
          <div style="font-size:9px;font-weight:600;color:#ffffff;background:rgba(0,0,0,0.75);border-radius:3px;padding:1px 4px;margin-top:2px;white-space:nowrap;">${ac.call_sign || ac.id}</div>
        </div>
      `
      const marker = new maplibregl.Marker({ element: el })
        .setLngLat([ac.longitude, ac.latitude])
        .setPopup(new maplibregl.Popup({ offset: 25 }).setHTML(`
          <div style="font-family:monospace;font-size:12px;">
            <b>${ac.call_sign || ac.id}</b><br/>
            Type: ${ac.beacon_type}<br/>
            Alt: ${ac.altitude} ft<br/>
            Spd: ${ac.ground_speed} kt<br/>
            Hdg: ${ac.course}<br/>
            Status: ${ac.status}
          </div>
        `))
        .addTo(map.current)
      markersRef.current[ac.id] = marker
    })
  }, [traffic, visible.traffic])

  const panel = {
    background: 'rgba(5,8,20,0.82)',
    borderRadius: 12,
    padding: '10px',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    border: '0.5px solid rgba(255,255,255,0.08)',
    zIndex: 10,
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />

      {/* Panel COUCHES */}
      <div style={{ position: 'absolute', top: 12, left: 12, ...panel, minWidth: 160 }}>
        <p style={{ fontSize: 8, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.15em', margin: '0 0 5px', fontFamily: 'monospace' }}>AIP LAYERS</p>

        {LAYERS.map(layer => (
          <div key={layer.id} style={{ marginBottom: 1 }}>
            {/* Capsule */}
            <div
              onClick={() => toggleLayer(layer.id)}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '4px 8px',
                borderRadius: layer.hasSlider && visible[layer.id] ? '6px 6px 0 0' : 6,
                background: visible[layer.id] ? `rgba(${layer.rgb},0.1)` : 'rgba(255,255,255,0.02)',
                borderLeft: `2px solid ${visible[layer.id] ? layer.color : 'rgba(255,255,255,0.07)'}`,
                cursor: 'pointer',
                transition: 'all 0.2s',
                userSelect: 'none',
              }}
            >
              <span style={{
                fontSize: 9, fontWeight: 500, fontFamily: 'monospace', letterSpacing: '0.06em',
                color: visible[layer.id] ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.2)',
                transition: 'color 0.2s',
              }}>
                {layer.label}
              </span>
              {layer.hasSlider && visible[layer.id] && (
                <span style={{ fontSize: 8, color: layer.color, fontFamily: 'monospace', marginLeft: 6 }}>
                  {opacity[layer.id]}%
                </span>
              )}
            </div>

            {/* Slider compact */}
            {layer.hasSlider && visible[layer.id] && (
              <div
                onClick={e => e.stopPropagation()}
                style={{
                  padding: '4px 8px 5px',
                  background: `rgba(${layer.rgb},0.04)`,
                  borderLeft: `2px solid ${layer.color}`,
                  borderRadius: '0 0 6px 6px',
                }}
              >
                <div style={{ position: 'relative', height: 10, display: 'flex', alignItems: 'center' }}>
                  <div style={{ position: 'absolute', width: '100%', height: 1, background: 'rgba(255,255,255,0.08)', borderRadius: 1 }} />
                  <div style={{ position: 'absolute', width: `${(opacity[layer.id] / 30) * 100}%`, height: 1, background: layer.color, borderRadius: 1 }} />
                  <div style={{
                    position: 'absolute',
                    left: `calc(${(opacity[layer.id] / 30) * 100}% - 4px)`,
                    width: 8, height: 8, borderRadius: '50%',
                    background: layer.color, pointerEvents: 'none',
                  }} />
                  <input
                    type="range" min={0} max={30} step={1}
                    value={opacity[layer.id]}
                    onChange={e => handleOpacity(layer.id, Number(e.target.value))}
                    style={{ position: 'absolute', width: '100%', opacity: 0, cursor: 'pointer', height: 10, margin: 0 }}
                  />
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Panel FOND DE CARTE */}
      <div style={{ position: 'absolute', bottom: 30, left: 12, ...panel, minWidth: 160 }}>
        <p style={{ fontSize: 8, color: 'rgba(255,255,255,0.2)', letterSpacing: '0.15em', margin: '0 0 5px', fontFamily: 'monospace' }}>FOND DE CARTE</p>
        {BASEMAPS.map(bm => (
          <div
            key={bm.id}
            onClick={() => changeBasemap(bm.id)}
            style={{
              padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
              background: activeBasemap === bm.id ? 'rgba(255,255,255,0.08)' : 'transparent',
              borderLeft: `2px solid ${activeBasemap === bm.id ? 'rgba(255,255,255,0.4)' : 'transparent'}`,
              transition: 'all 0.15s',
            }}
          >
            <span style={{
              fontSize: 9, fontFamily: 'monospace', fontWeight: 500, letterSpacing: '0.06em',
              color: activeBasemap === bm.id ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.2)',
            }}>
              {bm.label.toUpperCase()}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
