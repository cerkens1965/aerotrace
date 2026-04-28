import { useEffect, useRef } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'

const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY
const OPENAIP_KEY = import.meta.env.VITE_OPENAIP_KEY

export default function AerotraceMap() {
  const mapContainer = useRef(null)
  const map = useRef(null)

  useEffect(() => {
    if (map.current) return

    map.current = new maplibregl.Map({
      container: mapContainer.current,
      style: `https://api.maptiler.com/maps/outdoor-v2/style.json?key=${MAPTILER_KEY}`,
      center: [4.35, 50.85],
      zoom: 9,
    })

    map.current.addControl(new maplibregl.NavigationControl(), 'top-right')

    map.current.on('load', () => {
      // OpenAIP airspaces
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
          'fill-color': [
            'match', ['get', 'type'],
            2, 'rgba(255,0,0,0.1)',
            3, 'rgba(0,0,255,0.1)',
            'rgba(100,100,255,0.05)'
          ],
          'fill-outline-color': [
            'match', ['get', 'type'],
            2, 'rgba(255,0,0,0.8)',
            3, 'rgba(0,0,255,0.8)',
            'rgba(100,100,255,0.5)'
          ],
        }
      })
    })

    return () => {
      map.current?.remove()
      map.current = null
    }
  }, [])

  return (
    <div
      ref={mapContainer}
      style={{ width: '100%', height: '100%' }}
    />
  )
}