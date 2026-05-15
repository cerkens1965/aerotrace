import { useState, useEffect, useRef } from 'react'

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
        if (data.nearby_traffic) setTraffic(data.nearby_traffic)
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
