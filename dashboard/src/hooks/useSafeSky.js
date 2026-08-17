import { useState, useEffect, useRef } from 'react'

// bounds: { latMin, lonMin, latMax, lonMax }
export default function useSafeSky(bounds) {
  const [traffic, setTraffic] = useState([])
  const intervalRef = useRef(null)

  useEffect(() => {
    if (!bounds) return
    const { latMin, lonMin, latMax, lonMax } = bounds

    const fetchTraffic = async () => {
      try {
        const res = await fetch(
          `/safesky/traffic?lat_min=${latMin}&lon_min=${lonMin}&lat_max=${latMax}&lon_max=${lonMax}`
        )
        const data = await res.json()
        // ⚠️ API REST SafeSky /traffic = altitude en MÈTRES (le viewer live.safesky.app convertit
        // en pieds, pas l'API). Le dashboard affiche en « ft » → conversion m→ft à la source.
        if (data.nearby_traffic) setTraffic(data.nearby_traffic.map(t =>
          ({ ...t, altitude: t.altitude != null ? Math.round(t.altitude * 3.28084) : t.altitude,
           ground_speed: t.ground_speed != null ? t.ground_speed * 1.94384 : t.ground_speed })))   // ⚠️ ground_speed aussi en SI (m/s) → kt (un liner affichait 176 « kt » réels 343)
      } catch (error) {
        console.error('SafeSky fetch error:', error)
      }
    }

    fetchTraffic()
    intervalRef.current = setInterval(fetchTraffic, 3000)   // (2026-08-17) 5→3 s : fluidité live (1 requête viewport, pas de fan-out)
    return () => clearInterval(intervalRef.current)
  }, [bounds?.latMin, bounds?.lonMin, bounds?.latMax, bounds?.lonMax])

  return traffic
}
