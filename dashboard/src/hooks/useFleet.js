import { useState, useEffect, useRef, useCallback } from 'react'
import { collection, onSnapshot, query, where } from 'firebase/firestore'
import { db } from '../firebase/config'

const POLL_INTERVAL_MS = 5000
const IN_FLIGHT_ALT_FT = 50          // seuil altitude → en vol
const STALE_MS         = 3 * 60000   // 3 min sans signal → LTE_LOST

// Fixed viewport covering Belgium + surroundings (~150 km radius)
const FLEET_VIEWPORT = 'lat_min=49.40&lon_min=2.30&lat_max=51.80&lon_max=6.50'

/**
 * Croise la flotte Firestore avec le trafic SafeSky.
 *
 * status : 'IN_FLIGHT' | 'GROUNDED' | 'LTE_LOST' | 'UNKNOWN'
 * - IN_FLIGHT  : SafeSky airborne (alt > 50ft et speed > 0)  OU  FDR mode=MODE_FLIGHT
 * - LTE_LOST   : FDR dit MODE_FLIGHT mais SafeSky muet depuis > 3 min
 * - GROUNDED   : SafeSky status=GROUNDED ou (speed=0 et vrate=0)  OU  FDR mode=préflight/postflight/sleep
 * - UNKNOWN    : aucune donnée
 */
export default function useFleet(clubId) {
  const [aircraft,  setAircraft]  = useState([])
  const [fdrStatus, setFdrStatus] = useState({})
  const [safesky,   setSafesky]   = useState([])
  const [fleetBcn,  setFleetBcn]  = useState({})   // FlyADSL /beacons/search par callsign — réseau + monde entier
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState(null)
  const timerRef = useRef(null)

  // ── 1. Flotte Firestore ────────────────────────────────────────────────────
  useEffect(() => {
    if (!clubId) return
    const q = query(collection(db, 'aircraft'), where('clubId', '==', clubId))
    const unsub = onSnapshot(q,
      snap => { setAircraft(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => !a.archived)); setLoading(false) },   // (T18) archivés exclus des vues live
      err  => { console.error('[useFleet] aircraft:', err); setError(err); setLoading(false) }
    )
    return () => unsub()
  }, [clubId])

  // ── 2. FDR status (ESP32) ──────────────────────────────────────────────────
  useEffect(() => {
    if (!clubId) return
    const q = query(collection(db, 'fdr_status'), where('clubId', '==', clubId))
    const unsub = onSnapshot(q,
      snap => {
        const map = {}
        snap.docs.forEach(d => { map[d.data().icao24] = { id: d.id, ...d.data() } })
        setFdrStatus(map)
      },
      err => console.error('[useFleet] fdr_status:', err)
    )
    return () => unsub()
  }, [clubId])

  // ── 3. SafeSky polling — URL relative (dev: Vite proxy, prod: CF rewrite) ─
  const fetchSafeSky = useCallback(async () => {
    try {
      const res = await fetch(`/safesky/traffic?${FLEET_VIEWPORT}&show_grounded=true`)
      if (!res.ok) throw new Error(`SafeSky ${res.status}`)
      const data = await res.json()
      // ⚠️ L'API REST SafeSky /traffic renvoie l'altitude en MÈTRES (le viewer live.safesky.app
      // convertit en pieds, mais pas l'API). Tout le dashboard l'affiche en « ft » → on convertit
      // m→ft ICI, à la source, pour que tous les consommateurs (carte, En Vol) soient justes.
      const tr = Array.isArray(data?.nearby_traffic) ? data.nearby_traffic.map(t =>
        ({ ...t, altitude: t.altitude != null ? Math.round(t.altitude * 3.28084) : t.altitude,
           ground_speed: t.ground_speed != null ? t.ground_speed * 1.94384 : t.ground_speed })) : []   // ⚠️ ground_speed aussi en SI (m/s) → kt, cohérent avec le chemin beacon
      setSafesky(tr)
    } catch (err) {
      console.warn('[useFleet] SafeSky poll failed:', err.message)
    }
  }, [])

  useEffect(() => {
    fetchSafeSky()
    timerRef.current = setInterval(fetchSafeSky, POLL_INTERVAL_MS)
    return () => clearInterval(timerRef.current)
  }, [fetchSafeSky])

  // ── 3bis. Balises FlyADSL par callsign (réseau : app SafeSky, ADS-L AeroTrace…) ──
  // Le flux uav-api ci-dessus = sources RADIO uniquement. Ici on interroge FlyADSL
  // pour CHAQUE avion listé du club — toutes sources, sans limite de viewport (un
  // membre en voyage dans les Alpes reste vu). Poll 15 s (N requêtes côté CF).
  useEffect(() => {
    const signs = aircraft.map(a => a.callSign).filter(Boolean)
    if (!signs.length) return
    let stop = false
    const poll = async () => {
      try {
        const res = await fetch(`/safesky/fleet?call_signs=${signs.join(',')}`)
        if (!res.ok) throw new Error(`fleet ${res.status}`)
        const data = await res.json()
        if (!stop) setFleetBcn(data.beacons ?? {})
      } catch (err) { console.warn('[useFleet] fleet beacons poll failed:', err.message) }
    }
    poll()
    const t = setInterval(poll, 15000)
    return () => { stop = true; clearInterval(t) }
  }, [aircraft])

  // ── 4. Fusion statut ──────────────────────────────────────────────────────
  const fleet = aircraft.map(ac => {
    const fdr = fdrStatus[ac.icao24] ?? null
    // Balise FlyADSL (réseau) fraîche < 3 min → source PRIORITAIRE (elle voit l'app
    // SafeSky et les balises AeroTrace, que le flux radio uav-api ne contient pas).
    const bcnRaw = ac.callSign ? fleetBcn[ac.callSign.toUpperCase()] : null
    const bcnFresh = bcnRaw && (Date.now() / 1000 - (bcnRaw.timestamp ?? 0)) < 180
    const bcn = bcnFresh ? {
      id: bcnRaw.address,
      call_sign: bcnRaw.call_sign,
      latitude: bcnRaw.latitude,
      longitude: bcnRaw.longitude,
      altitude: bcnRaw.altitude != null ? Math.round(bcnRaw.altitude * 3.28084) : null,  // m → ft
      ground_speed: bcnRaw.ground_speed != null ? bcnRaw.ground_speed * 1.94384 : null,  // m/s → kt (FlyADSL est en SI, cf altitude m→ft ci-dessus ; affiché brut la vitesse était ~2× trop basse)
      vertical_rate: bcnRaw.vertical_rate,
      course: bcnRaw.ground_track,
      status: bcnRaw.flight_state,           // AIRBORNE | GROUNDED
      source: 'network',
    } : null
    const sky = bcn ?? safesky.find(t =>
      t.id?.toUpperCase() === ac.icao24?.toUpperCase() ||
      (ac.callSign && t.call_sign?.toUpperCase() === ac.callSign.toUpperCase())
    ) ?? null

    const now      = Date.now()
    const skyAlt   = sky?.altitude ?? 0
    const fdrMode  = fdr?.mode ?? null
    const fdrTs    = fdr?.updatedAt?.toMillis?.() ?? 0
    const skyTs    = sky ? now : 0

    // SafeSky status=GROUNDED, ou immobile (speed=0 et vrate=0), ou sous le seuil
    const skyGrounded =
      sky?.status === 'GROUNDED' ||
      (sky && (sky.ground_speed ?? 1) === 0 && (sky.vertical_rate ?? 1) === 0) ||
      (sky && skyAlt <= IN_FLIGHT_ALT_FT)

    let status = 'UNKNOWN'

    if (sky && !skyGrounded) {
      status = 'IN_FLIGHT'
    } else if (fdrMode === 'MODE_FLIGHT') {
      const stale = skyTs === 0 && (now - fdrTs) > STALE_MS
      status = stale ? 'LTE_LOST' : 'IN_FLIGHT'
    } else if (skyGrounded) {
      status = 'GROUNDED'
    } else if (fdrMode === 'MODE_POSTFLIGHT' || fdrMode === 'MODE_PREFLIGHT' || fdrMode === 'MODE_SLEEP') {
      status = 'GROUNDED'
    }

    return {
      ...ac,
      status,
      liveData: sky ? {
        altitude:   sky.altitude,
        speed:      sky.ground_speed,
        heading:    sky.course,
        lat:        sky.latitude,
        lon:        sky.longitude,
        beaconType: sky.beacon_type,
        lastSeen:   now,
      } : null,
      fdrData: fdr ? {
        mode:     fdr.mode,
        lat:      fdr.lat,
        lon:      fdr.lon,
        alt:      fdr.alt_m,
        spd:      fdr.spd_kt,
        hdg:      fdr.hdg_deg ?? null,
        rpm:      fdr.rpm,
        co:       fdr.co_ppm,
        lastSeen: fdrTs,
      } : null,
      pilotName:   fdr?.pilotName  ?? ac.assignedPilot ?? null,
      flightStart: fdr?.flightStart ?? null,
    }
  })

  return {
    fleet,
    inFlight: fleet.filter(a => a.status === 'IN_FLIGHT' || a.status === 'LTE_LOST'),
    grounded: fleet.filter(a => a.status === 'GROUNDED'),
    unknown:  fleet.filter(a => a.status === 'UNKNOWN'),
    loading,
    error,
  }
}
