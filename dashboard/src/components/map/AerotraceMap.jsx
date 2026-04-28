import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import useSafeSky from '../../hooks/useSafeSky'

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY
const OPENAIP_KEY = import.meta.env.VITE_OPENAIP_KEY

const CENTER = { lat: 50.85, lon: 4.35 }

export default function AerotraceMap() {
  const mapContainer = useRef(null)
  const map = useRef(null)
  const markersRef = useRef({})
  const traffic = useSafeSky(CENTER)

  useEffect(() => {
    if (map.current) return

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`,
      center: [CENTER.lon, CENTER.lat],
      zoom: 9,
    })

    map.current.addControl(new maplibregl.NavigationControl(), 'top-right')

    map.current.on('load', () => {
      map.current.addSource('openaip', {
        type: 'vector',
        tiles: [`https://api.tiles.openaip.net/api/data/openaip/{z}/{x}/{y}.pbf?apiKey=${OPENAIP_KEY}`],
        minzoom: 0,
        maxzoom: 14,
      })
      map.current.addLayer({
        id: 'airspaces-fill',
        type: 'fill',
        source: 'openaip',
        'source-layer': 'airspaces',
        paint: {
          'fill-color': 'rgba(100,100,255,0.05)',
          'fill-outline-color': 'rgba(100,100,255,0.5)',
        }
      })
    })

    return () => {
      map.current?.remove()
      map.current = null
    }
  }, [])

  // Mise à jour des marqueurs trafic
  useEffect(() => {
    if (!map.current) return

    // Supprime les anciens marqueurs
    Object.values(markersRef.current).forEach(m => m.remove())
    markersRef.current = {}

    // Ajoute les nouveaux
    traffic.forEach(ac => {
      const el = document.createElement('div')
      el.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;">
          <div style="
            width:12px;height:12px;
            background:#00ff88;
            border:2px solid white;
            border-radius:50%;
            transform:rotate(${ac.course || 0}deg);
          "></div>
          <div style="
            font-size:9px;font-weight:600;
            color:#ffffff;
            background:rgba(0,0,0,0.7);
            border-radius:3px;
            padding:1px 4px;
            margin-top:2px;
            white-space:nowrap;
          ">${ac.call_sign || ac.id}</div>
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
            Hdg: ${ac.course}°<br/>
            Status: ${ac.status}
          </div>
        `))
        .addTo(map.current)

      markersRef.current[ac.id] = marker
    })
  }, [traffic])

  return (
    <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
  )
}