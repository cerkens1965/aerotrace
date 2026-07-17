// src/utils/logbookUtils.js
// Shared helpers for the Logbook feature
//
// ── Firestore /flights/{id} schema (enriched) ──────────────────────────────
//
//   aircraftIdent   : string        ← registration (denorm, e.g. OO-VL3)
//   pilotId         : string        ← ref /pilots/{id}  — PIC or student at controls
//   pilotRole       : 'student' | 'pilot'   ← role during THIS flight
//
//   instructorId    : string | null ← ref /pilots/{id}  — required when pilotRole='student'
//   instructorOnboard: boolean|null ← true=aboard / false=supervising from ground
//
//   flightType      : 'solo' | 'dual' | 'solo_supervised' | 'rental'
//     auto-derived:
//       pilotRole=pilot                               → solo (or rental if flagged)
//       pilotRole=student + instructor + onboard=true → dual
//       pilotRole=student + instructor + onboard=false→ solo_supervised
//
//   validated       : boolean       ← admin has assigned pilot+aircraft (default false)
//   clubId          : string
//
//   fileName, csvStoragePath, csvUrl, startTs, endTs
//   duration (seconds), maxAlt (ft), maxSpd (kt), maxG, maxRpm, bounds
//   uploadedAt
// ──────────────────────────────────────────────────────────────────────────

export function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0h 00m'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${String(m).padStart(2, '0')}m`
}

export function formatDate(ts, short = false) {
  if (!ts) return '—'
  try {
    const d = ts?.toDate ? ts.toDate() : new Date(ts)
    if (short) return d.toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    return (
      d.toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
      ' ' + d.toLocaleTimeString('fr-BE', { hour: '2-digit', minute: '2-digit' })
    )
  } catch { return '—' }
}

/**
 * startTs → epoch ms. Tolère les DEUX types présents en base : un nombre (epoch ms — ce
 * qu'écrivent normalizeFlight et l'upload dashboard) ou un Timestamp Firestore (docs
 * historiques). Indispensable : `ts?.toDate?.() || 0` sur un nombre donne 0 silencieusement
 * et tue le tri. 0 si absent/illisible → l'élément part en fin de tri desc.
 */
export function tsMillis(ts) {
  if (ts == null) return 0
  if (typeof ts === 'number') return ts
  if (typeof ts.toMillis === 'function') return ts.toMillis()
  if (typeof ts.toDate === 'function') return ts.toDate().getTime()
  const t = new Date(ts).getTime()
  return isNaN(t) ? 0 : t
}

export function sortByDateDesc(arr) {
  return [...arr].sort((a, b) => tsMillis(b.startTs) - tsMillis(a.startTs))
}

// Derive flightType from assignment fields
export function deriveFlightType(pilotRole, instructorId, instructorOnboard) {
  if (!pilotRole) return null
  if (pilotRole === 'pilot') return 'solo'
  if (pilotRole === 'student') {
    if (!instructorId) return 'solo'
    return instructorOnboard ? 'dual' : 'solo_supervised'
  }
  return 'solo'
}

export const FLIGHT_TYPES = {
  solo:            { label: 'Solo',              short: 'SOLO',   color: '#22c55e' },
  dual:            { label: 'Double commande',   short: 'DBL CMD', color: '#F5A623' },
  solo_supervised: { label: 'Solo supervisé',    short: 'SUPERVISÉ', color: '#60a5fa' },
  rental:          { label: 'Location',          short: 'LOCATION', color: '#a78bfa' },
  // Pas un vol : démarrage/roulage/artefact d'enregistrement (jamais décollé). Marqué à
  // l'import pour rester filtrable et supprimable en lot, sans polluer les totaux d'heures.
  // deriveFlightType ne le produit jamais — il n'est posé que par un import explicite.
  ground:          { label: 'Sol / roulage',     short: 'SOL',    color: '#6b7c8d' },
}

export function getPilotName(pilots, id) {
  if (!id) return '—'
  const p = pilots.find(x => x.id === id)
  return p ? `${p.firstName} ${p.lastName}` : '—'
}

export function flightTypeBadge(type) {
  const ft = FLIGHT_TYPES[type]
  if (!ft) return null
  return { label: ft.short, color: ft.color }
}

// Total seconds from a list of flight objects
export function sumDuration(flights) {
  return flights.reduce((s, f) => s + (f.duration || 0), 0)
}
