import { useState, useEffect, useRef, useCallback } from 'react'
import { collection, onSnapshot, query, where } from 'firebase/firestore'
import { db } from '../firebase/config'

const POLL_INTERVAL_MS = 5000
const IN_FLIGHT_ALT_FT = 50          // seuil altitude SafeSky → en vol
const STALE_MS         = 3 * 60000   // 3 min sans signal → signal perdu

/**
 * Croise la flotte Firestore avec le trafic SafeSky.
 *
 * Retourne pour chaque appareil :
 *   status : 'IN_FLIGHT' | 'GROUNDED' | 'LTE_LOST' | 'UNKNOWN'
 *   - IN_FLIGHT  : SafeSky rapporte alt > 50ft  OU  FDR mode = MODE_FLIGHT
 *   - LTE_LOST   : FDR dit MODE_FLIGHT mais SafeSky muet depuis > 3 min
 *   - GROUNDED   : SafeSky alt ≤ 50ft ET FDR mode ≠ MODE_FLIGHT
 *   - UNKNOWN    : aucune donnée
 */
export default function useFleet(clubId) {
  const [aircraft,    setAircraft]    = useState([])   // flotte Firestore
  const [fdrStatus,   setFdrStatus]   = useState({})   // { icao24: { mode, ts, lat, lon, alt, spd } }
  const [safesky,     setSafesky]     = useState([])   // trafic SafeSky brut
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState(null)
  const timerRef = useRef(null)

  // ── 1. Écoute flotte Firestore ─────────────────────────────────────────────
  useEffect(() => {
    if (!clubId) return
    const q = query(collection(db, 'aircraft'), where('clubId', '==', clubId))
    const unsub = onSnapshot(q,
      snap => {
        setAircraft(snap.docs.map(d => ({ id: d.id, ...d.data() })))
        setLoading(false)
      },
      err => {
        console.error('[useFleet] aircraft listener:', err)
        setError(err)
        setLoading(false)
      }
    )
    return () => unsub()
  }, [clubId])

  // ── 2. Écoute statut FDR en temps réel (ESP32 écrit ici) ──────────────────
  useEffect(() => {
    if (!clubId) return
    const q = query(collection(db, 'fdr_status'), where('clubId', '==', clubId))
    const unsub = onSnapshot(q,
      snap => {
        const map = {}
        snap.docs.forEach(d => { map[d.data().icao24] = { id: d.id, ...d.data() } })
        setFdrStatus(map)
      },
      err => console.error('[useFleet] fdr_status listener:', err)
    )
    return () => unsub()
  }, [clubId])

  // ── 3. Polling SafeSky via proxy ───────────────────────────────────────────
  const fetchSafeSky = useCallback(async () => {
    try {
      // Centre Brussels par défaut — idéalement centré sur la flotte connue
      const res = await fetch('http://localhost:3001/safesky/traffic?lat=50.5686&lon=4.4347')
      if (!res.ok) throw new Error(`SafeSky proxy ${res.status}`)
      const data = await res.json()
      // Le proxy renvoie { nearby_traffic: [...] } — pas un array brut
      setSafesky(Array.isArray(data?.nearby_traffic) ? data.nearby_traffic : [])
    } catch (err) {
      console.warn('[useFleet] SafeSky poll failed:', err.message)
      // Ne pas crasher — SafeSky peut être indispo
    }
  }, [])

  useEffect(() => {
    fetchSafeSky()
    timerRef.current = setInterval(fetchSafeSky, POLL_INTERVAL_MS)
    return () => clearInterval(timerRef.current)
  }, [fetchSafeSky])

  // ── 4. Fusion statut ──────────────────────────────────────────────────────
  const fleet = aircraft.map(ac => {
    const fdr = fdrStatus[ac.icao24] ?? null
    const sky = safesky.find(t =>
      t.id === ac.icao24 ||
      (ac.callSign && t.call_sign?.toUpperCase() === ac.callSign.toUpperCase())
    ) ?? null

    const now       = Date.now()
    const skyAlt    = sky?.altitude ?? 0
    const fdrMode   = fdr?.mode ?? null
    const fdrTs     = fdr?.updatedAt?.toMillis?.() ?? 0
    const skyTs     = sky ? now : 0
    const lastSeen  = Math.max(fdrTs, skyTs)

    let status = 'UNKNOWN'

    if (skyAlt > IN_FLIGHT_ALT_FT) {
      status = 'IN_FLIGHT'
    } else if (fdrMode === 'MODE_FLIGHT') {
      // FDR dit "en vol" mais SafeSky muet
      const stale = skyTs === 0 && (now - fdrTs) > STALE_MS
      status = stale ? 'LTE_LOST' : 'IN_FLIGHT'
    } else if (fdrMode === 'MODE_POSTFLIGHT' || fdrMode === 'MODE_PREFLIGHT' || fdrMode === 'MODE_SLEEP') {
      status = 'GROUNDED'
    } else if (skyAlt <= IN_FLIGHT_ALT_FT && sky) {
      status = 'GROUNDED'
    }

    return {
      ...ac,
      status,
      liveData: sky ? {
        altitude:    sky.altitude,
        speed:       sky.ground_speed,
        heading:     sky.course,
        lat:         sky.latitude,
        lon:         sky.longitude,
        beaconType:  sky.beacon_type,
        lastSeen:    now,
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
      pilotName:  fdr?.pilotName  ?? ac.assignedPilot ?? null,
      flightStart: fdr?.flightStart ?? null,
    }
  })

  const inFlight  = fleet.filter(a => a.status === 'IN_FLIGHT' || a.status === 'LTE_LOST')
  const grounded  = fleet.filter(a => a.status === 'GROUNDED')
  const unknown   = fleet.filter(a => a.status === 'UNKNOWN')

  return { fleet, inFlight, grounded, unknown, loading, error }
}
