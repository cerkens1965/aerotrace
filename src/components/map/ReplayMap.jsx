import { useEffect, useRef, useCallback } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { subsampleFrames } from '../utils/csvParser'

const MAPTILER_KEY  = import.meta.env.VITE_MAPTILER_KEY
const OPENAIP_KEY   = import.meta.env.VITE_OPENAIP_KEY

const PHASE_COLORS = {
  GROUND:   '#ffffff',
  CRUISE:   '#22c55e',
  MANEUVER: '#f97316',
  APPROACH: '#F5A623',
  CRITICAL: '#ef4444',
}

export default function ReplayMap({ frames, currentFrame, is3D = false }) {
  const mapRef    = useRef(null)
  const mapObj    = useRef(null)
  const markerRef = useRef(null)
  const headRef   = useRef(null)

  // Init map
  useEffect(() => {
    if (!mapRef.current || mapObj.current) return

    const map = new maplibregl.Map({
      container: mapRef.current,
      style: `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`,
      center: [10.0, 60.5],
      zoom: 7,
      pitch: is3D ? 60 : 0,
      bearing: 0,
      antialias: true,
    })

    mapObj.current = map

    map.on('load', () => {
      // ── OpenAIP airspaces ──────────────────────────────────────────────
      map.addSource('openaip', {
        type: 'vector',
        tiles: [`https://api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.pbf?apiKey=${OPENAIP_KEY}`],
        minzoom: 0, maxzoom: 14,
      })
      map.addLayer({ id: 'ctr-fill', type: 'fill', source: 'openaip', 'source-layer': 'airspaces',
        filter: ['in', ['get', 'type'], ['literal', [1,2,3]]],
        paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.04 } })
      map.addLayer({ id: 'ctr-line', type: 'line', source: 'openaip', 'source-layer': 'airspaces',
        filter: ['in', ['get', 'type'], ['literal', [1,2,3]]],
        paint: { 'line-color': '#ef4444', 'line-width': 1, 'line-opacity': 0.6 } })
      map.addLayer({ id: 'tma-fill', type: 'fill', source: 'openaip', 'source-layer': 'airspaces',
        filter: ['in', ['get', 'type'], ['literal', [4,5]]],
        paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.04 } })
      map.addLayer({ id: 'tma-line', type: 'line', source: 'openaip', 'source-layer': 'airspaces',
        filter: ['in', ['get', 'type'], ['literal', [4,5]]],
        paint: { 'line-color': '#3b82f6', 'line-width': 1, 'line-opacity': 0.5 } })

      // ── 3D terrain ─────────────────────────────────────────────────────
      if (is3D) {
        map.addSource('terrain', {
          type: 'raster-dem',
          url: `https://api.maptiler.com/tiles/terrain-rgb-v2/tiles.json?key=${MAPTILER_KEY}`,
          tileSize: 256,
        })
        map.setTerrain({ source: 'terrain', exaggeration: 1.5 })
      }

      // ── Ghost trace (future - low opacity) ────────────────────────────
      const sub = subsampleFrames(frames || [], 3000)
      const ghostCoords = sub.map(f => [f.lon, f.lat])

      if (ghostCoords.length > 1) {
        map.addSource('ghost-trace', {
          type: 'geojson',
          data: { type: 'Feature', geometry: { type: 'LineString', coordinates: ghostCoords } }
        })
        map.addLayer({
          id: 'ghost-trace', type: 'line', source: 'ghost-trace',
          paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-opacity': 0.15 }
        })
      }

      // ── Played trace (segments by phase color) ────────────────────────
      map.addSource('played-trace', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] }
      })
      map.addLayer({
        id: 'played-trace', type: 'line', source: 'played-trace',
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 2.5,
          'line-opacity': 0.9,
        },
        layout: { 'line-join': 'round', 'line-cap': 'round' }
      })

      // ── Aircraft marker ───────────────────────────────────────────────
      const el = document.createElement('div')
      el.style.cssText = `
        width: 28px; height: 28px;
        background: #F5A623;
        border: 2px solid white;
        border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 14px;
        box-shadow: 0 0 12px rgba(245,166,35,0.8);
        transform-origin: center;
        transition: transform 0.3s;
      `
      el.innerHTML = '✈'
      markerRef.current = new maplibregl.Marker({ element: el, rotationAlignment: 'map' })
      headRef.current = 0

      // Fit to trace bounds
      if (frames && frames.length > 0) {
        const lats = frames.map(f => f.lat)
        const lons = frames.map(f => f.lon)
        map.fitBounds([
          [Math.min(...lons) - 0.1, Math.min(...lats) - 0.1],
          [Math.max(...lons) + 0.1, Math.max(...lats) + 0.1],
        ], { padding: 40, duration: 1000 })
      }
    })

    return () => {
      if (markerRef.current) markerRef.current.remove()
      map.remove()
      mapObj.current = null
    }
  }, [is3D])

  // Update played trace + marker when currentFrame changes
  useEffect(() => {
    const map = mapObj.current
    if (!map || !map.isStyleLoaded() || !currentFrame || !frames) return

    // Build played trace up to currentFrame
    const played = frames.filter(f => f.ts <= currentFrame.ts)
    const sub    = subsampleFrames(played, 2000)

    const features = []
    for (let i = 1; i < sub.length; i++) {
      features.push({
        type: 'Feature',
        properties: { color: PHASE_COLORS[sub[i].phase] ?? '#22c55e' },
        geometry: { type: 'LineString', coordinates: [[sub[i-1].lon, sub[i-1].lat], [sub[i].lon, sub[i].lat]] }
      })
    }

    const src = map.getSource('played-trace')
    if (src) src.setData({ type: 'FeatureCollection', features })

    // Move marker
    markerRef.current
      .setLngLat([currentFrame.lon, currentFrame.lat])
      .setRotation(currentFrame.hdg ?? 0)
      .addTo(map)

    // Smooth follow in 3D mode
    if (is3D) {
      map.easeTo({
        center: [currentFrame.lon, currentFrame.lat],
        bearing: currentFrame.hdg ?? 0,
        pitch: 60,
        duration: 500,
        easing: t => t,
      })
    }
  }, [currentFrame, frames, is3D])

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={mapRef} style={{ width: '100%', height: '100%' }} />

      {/* Phase legend */}
      <div style={{
        position: 'absolute', top: 10, right: 10,
        background: 'rgba(5,8,20,0.85)', borderRadius: 8,
        padding: '8px 10px', border: '1px solid rgba(255,255,255,0.07)',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}>
        {Object.entries(PHASE_COLORS).map(([phase, color]) => (
          <div key={phase} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 16, height: 3, background: color, borderRadius: 1 }} />
            <span style={{ fontFamily: 'monospace', fontSize: 7, color: '#ffffff' }}>{phase}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
