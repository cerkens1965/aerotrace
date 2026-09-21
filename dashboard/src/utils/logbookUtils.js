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
//   archived        : boolean       ← soft delete (never deleteDoc) + archivedAt, archivedBy
//   source          : 'dashboard-import' | …  ← origin of the doc (Logbook CSV import)
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

// ── Pays d'un aérodrome, déduit de son préfixe OACI ──────────────────────────
// La base AIP (format ADP2) ne stocke que ICAO + lat/lon + type : pas de pays. Le
// préfixe est la seule source. Fiable en Europe, sauf pour les dépendances, d'où
// ICAO_COUNTRY_EXACT ci-dessous.
const ICAO_COUNTRY = {
  BI: 'IS', EB: 'BE', ED: 'DE', EF: 'FI', EG: 'GB', EH: 'NL', EI: 'IE', EK: 'DK',
  EL: 'LU', EN: 'NO', EP: 'PL', ES: 'SE', ET: 'DE', GC: 'ES', GE: 'ES', LD: 'HR',
  LE: 'ES', LF: 'FR', LG: 'GR', LH: 'HU', LI: 'IT', LJ: 'SI', LK: 'CZ', LO: 'AT',
  LP: 'PT', LR: 'RO', LS: 'CH', LZ: 'SK',
}
// Exceptions : le préfixe désigne l'État responsable, pas le territoire.
// EKVG = Vágar, seul aéroport des Féroé, sous préfixe danois (les autres EKV* sont
// bien danois → ne surtout pas généraliser EKV → FO).
// EGJ* = îles anglo-normandes (absentes de la base au 2026-07-17, mais prêtes).
const ICAO_COUNTRY_EXACT = { EKVG: 'FO', EGJB: 'GG', EGJA: 'GG', EGJJ: 'JE' }

/** Code OACI → code pays ISO 3166-1 alpha-2, ou null si préfixe inconnu. */
export function icaoCountry(icao) {
  if (!icao || icao.length < 2) return null
  const up = icao.toUpperCase()
  return ICAO_COUNTRY_EXACT[up] || ICAO_COUNTRY[up.slice(0, 2)] || null
}

/**
 * ISO 3166-1 alpha-2 → drapeau (indicateurs régionaux Unicode).
 * ⚠️ Windows n'a pas de police drapeau : le navigateur y affichera les 2 lettres
 * (« BE ») au lieu de 🇧🇪. Dégradation acceptable — l'info reste lisible.
 */
export function countryFlag(iso2) {
  if (!iso2 || iso2.length !== 2) return ''
  return String.fromCodePoint(...[...iso2.toUpperCase()].map(c => 0x1f1e6 + c.charCodeAt(0) - 65))
}

/** Code OACI → drapeau de son pays ('' si inconnu). */
export function icaoFlag(icao) {
  return countryFlag(icaoCountry(icao))
}

/**
 * Single date format across the Logbook: « 21 Sep 2026 » (en-GB, UTC).
 * UTC because every timestamp in the system (CSV, FDR, Firestore) is UTC — a local
 * rendering would shift a late-evening flight to the next day.
 * Mois en dur : toLocaleDateString('en-GB', {month:'short'}) donne « Sept » avec le
 * CLDR récent (Chrome, Node) — on veut « Sep » partout, quel que soit le navigateur.
 */
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function formatDate(ts) {
  if (ts == null || ts === '') return '—'
  try {
    const d = ts?.toDate ? ts.toDate() : new Date(ts)
    if (isNaN(d.getTime())) return '—'
    return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS_EN[d.getUTCMonth()]} ${d.getUTCFullYear()}`
  } catch { return '—' }
}

/** « 21 Sep 2026 · 14:32 UTC » — same date format plus the UTC time. */
export function formatDateTime(ts) {
  if (ts == null || ts === '') return '—'
  try {
    const d = ts?.toDate ? ts.toDate() : new Date(ts)
    if (isNaN(d.getTime())) return '—'
    const time = `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    return `${formatDate(ts)} · ${time} UTC`
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

/**
 * RÈGLE UNIQUE de dérivation du statut d'un pilote pour un vol.
 * Un pilote est élève UNIQUEMENT si son profil porte licence === 'student'.
 * Absence du champ licence → breveté (pilot) : c'est le cas majoritaire en base et
 * l'ancien défaut inverse (pas de licence → élève) réclamait un instructeur à tort.
 * Seul un élève exige un instructeur à l'assignation.
 */
export function isStudent(pilot) {
  return pilot?.licence === 'student'
}

/**
 * VOLS PROPRIÉTAIRE — avion ownership === 'owner' avec ownerPilotId : piloté par son
 * propriétaire. Renvoie l'id du pilote propriétaire de l'avion identifié par `ident`
 * (callSign canonique OU registration legacy), '' sinon.
 */
export function ownerPilotIdFor(aircraft, ident) {
  if (!ident) return ''
  const a = (aircraft || []).find(x => x.callSign === ident || x.registration === ident)
  return (a && a.ownership === 'owner' && a.ownerPilotId) ? a.ownerPilotId : ''
}

/**
 * Un vol est « To assign » s'il n'est pas validé, SAUF vol propriétaire dont le pilote
 * est déjà renseigné (attribution automatique : rien à demander). Un vol propriétaire
 * sans pilotId (import) reste dans la file ; la modale le pré-remplit.
 */
export function needsAssignment(flight, aircraft) {
  if (flight.validated) return false
  if (flight.pilotId && ownerPilotIdFor(aircraft, flight.aircraftIdent)) return false
  return true
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
  dual:            { label: 'Dual',              short: 'DUAL',   color: '#F5A623' },
  solo_supervised: { label: 'Supervised solo',   short: 'SUPERVISED', color: '#60a5fa' },
  rental:          { label: 'Rental',            short: 'RENTAL', color: '#a78bfa' },
  // Pas un vol : démarrage/roulage/artefact d'enregistrement (jamais décollé). Marqué à
  // l'import pour rester filtrable et supprimable en lot, sans polluer les totaux d'heures.
  // deriveFlightType ne le produit jamais — il n'est posé que par un import explicite.
  ground:          { label: 'Ground / taxi',     short: 'GROUND', color: '#6b7c8d' },
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

/**
 * Relie un compte connecté à sa fiche /pilots : fiche du club dont `email` correspond
 * à l'e-mail du compte (insensible à la casse, espaces ignorés). null si aucune.
 * Fiches archivées ignorées. Si plusieurs fiches partagent l'e-mail, la première gagne.
 */
export function findPilotForEmail(pilots, email) {
  const key = (email || '').trim().toLowerCase()
  if (!key) return null
  return (pilots || []).find(p => p.archived !== true && (p.email || '').trim().toLowerCase() === key) || null
}

/**
 * Fiche /pilots du compte connecté. D'ABORD par uid (liaison posée par le code
 * d'invitation : pilots/{id}.uid = uid du compte), PUIS par e-mail en repli
 * (findPilotForEmail). null si aucune. Fiches archivées ignorées.
 */
export function findMyPilot(pilots, user) {
  if (!user) return null
  const byUid = user.uid
    ? (pilots || []).find(p => p.archived !== true && p.uid === user.uid)
    : null
  return byUid || findPilotForEmail(pilots, user.email)
}
