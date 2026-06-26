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
          ({ ...t, altitude: t.altitude != null ? Math.round(t.altitude * 3.28084) : t.altitude })))
      } catch (error) {
        console.error('SafeSky fetch error:', error)
      }
    }

    fetchTraffic()
    intervalRef.current = setInterval(fetchTraffic, 5000)
    return () => clearInterval(intervalRef.current)
  }, [bounds?.latMin, bounds?.lonMin, bounds?.latMax, bounds?.lonMax])

  return traffic
}
