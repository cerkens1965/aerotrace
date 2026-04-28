import { useState, useEffect, useRef } from 'react'

export default function useSafeSky(center) {
  const [traffic, setTraffic] = useState([])
  const intervalRef = useRef(null)

  useEffect(() => {
    const fetchTraffic = async () => {
      try {
        const res = await fetch(
          `http://localhost:3001/safesky/traffic?lat=${center.lat}&lon=${center.lon}`
        )
        const data = await res.json()
        if (data.nearby_traffic) {
          setTraffic(data.nearby_traffic)
        }
      } catch (error) {
        console.error('SafeSky fetch error:', error)
      }
    }

    fetchTraffic()
    intervalRef.current = setInterval(fetchTraffic, 5000)
    return () => clearInterval(intervalRef.current)
  }, [center.lat, center.lon])

  return traffic
}