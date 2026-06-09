const { onRequest } = require('firebase-functions/v2/https')
const { onDocumentWritten, onDocumentDeleted } = require('firebase-functions/v2/firestore')
const { defineSecret } = require('firebase-functions/params')
const { initializeApp, getApps } = require('firebase-admin/app')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')
const crypto = require('crypto')
const zlib = require('zlib')

const STORAGE_BUCKET = 'aerotrace-74217.firebasestorage.app'

if (getApps().length === 0) initializeApp()

const SAFESKY_KEY = defineSecret('SAFESKY_KEY')

function deriveKid(apiKey) {
  const hash = crypto.createHash('sha256').update('kid:' + apiKey).digest()
  return hash.slice(0, 16).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function deriveHmacKey(apiKey) {
  const salt = Buffer.from('safesky-hmac-salt-v1', 'utf8')
  const info = Buffer.from('auth-v1', 'utf8')
  const prk = crypto.createHmac('sha256', salt).update(Buffer.from(apiKey, 'utf8')).digest()
  const t = crypto.createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest()
  return t.slice(0, 32)
}

function generateAuthHeaders(apiKey, method, url) {
  const parsed = new URL(url)
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const nonce = crypto.randomUUID()
  const kid = deriveKid(apiKey)
  const hmacKey = deriveHmacKey(apiKey)
  const bodyHash = crypto.createHash('sha256').update('').digest('hex')
  const canonical = [
    method.toUpperCase(),
    parsed.pathname,
    parsed.search ? parsed.search.slice(1) : '',
    `host:${parsed.host}`,
    `x-ss-date:${timestamp}`,
    `x-ss-nonce:${nonce}`,
    '',
    bodyHash,
  ].join('\n')
  const signature = crypto.createHmac('sha256', hmacKey).update(canonical).digest('base64')
  return {
    Authorization: `SS-HMAC Credential=${kid}/v1, SignedHeaders=host;x-ss-date;x-ss-nonce, Signature=${signature}`,
    'X-SS-Date': timestamp,
    'X-SS-Nonce': nonce,
    'X-SS-Alg': 'SS-HMAC-SHA256-V1',
  }
}

// ─── Pilot PIN deduplication ──────────────────────────────────────────────────
// Marque pinConflict=true sur les docs pilotes qui partagent le même (clubId, pin)
// qu'un autre pilote non-archivé. Détection après écriture (pas de blocage),
// pour permettre à l'admin de voir le conflit dans l'UI et le résoudre.
//
// Idempotent : ne réécrit jamais le flag s'il est déjà à la bonne valeur,
// donc pas de boucle infinie via le trigger.
async function recheckPilotConflict(db, pilotId, pilotData) {
  if (!pilotData) return                                  // doc supprimé
  if (pilotData.archived === true) return                 // archivé : ignore
  if (!pilotData.pin || !pilotData.clubId) {
    // Données incomplètes : ne peut pas être en conflit. Clear flag si présent.
    if (pilotData.pinConflict === true) {
      await db.collection('pilots').doc(pilotId).update({
        pinConflict: false,
        pinConflictUpdatedAt: FieldValue.serverTimestamp(),
      })
    }
    return
  }
  const snap = await db.collection('pilots')
    .where('clubId', '==', pilotData.clubId)
    .where('pin',    '==', pilotData.pin)
    .get()
  const others = snap.docs.filter(d => d.id !== pilotId && d.data().archived !== true)
  const hasConflict = others.length > 0
  if (pilotData.pinConflict === hasConflict) return       // pas de changement → skip (anti-loop)
  await db.collection('pilots').doc(pilotId).update({
    pinConflict: hasConflict,
    pinConflictUpdatedAt: FieldValue.serverTimestamp(),
  })
}

exports.dedupPilotPin = onDocumentWritten(
  { document: 'pilots/{pilotId}', region: 'europe-west1' },
  async (event) => {
    const db = getFirestore()
    const before = event.data?.before?.data() || null
    const after  = event.data?.after?.data()  || null
    const pilotId = event.params.pilotId

    // Anti-loop : si seuls pinConflict / pinConflictUpdatedAt ont changé, skip.
    if (before && after) {
      const stripMeta = (o) => {
        const { pinConflict, pinConflictUpdatedAt, updatedAt, ...rest } = o
        return JSON.stringify(rest)
      }
      if (stripMeta(before) === stripMeta(after)) return
    }

    // 1. Recheck le doc lui-même
    await recheckPilotConflict(db, pilotId, after)

    // 2. Recheck les docs qui partageaient l'ANCIEN (clubId, pin) — peut-être
    //    le conflit a-t-il disparu pour eux (le doc actuel n'est plus dans
    //    leur cluster).
    const oldKey = before && before.pin && before.clubId
        ? `${before.clubId}|${before.pin}` : null
    const newKey = after && after.pin && after.clubId
        ? `${after.clubId}|${after.pin}` : null
    const keysToRecheck = new Set()
    if (oldKey) keysToRecheck.add(oldKey)
    if (newKey && newKey !== oldKey) keysToRecheck.add(newKey)

    for (const key of keysToRecheck) {
      const [clubId, pin] = key.split('|')
      const snap = await db.collection('pilots')
        .where('clubId', '==', clubId)
        .where('pin',    '==', pin)
        .get()
      for (const d of snap.docs) {
        if (d.id === pilotId) continue              // déjà fait en (1)
        if (d.data().archived === true) continue
        await recheckPilotConflict(db, d.id, d.data())
      }
    }
  }
)

// ─── Normalisation des vols écrits par les boîtiers AT-CORE ───────────────────
// Le firmware POST un doc /flights brut en snake_case (aircraft_ident, icao24,
// boxId, flight_id, csvStoragePath, end_ts) SANS clubId ni les champs relationnels
// que le dashboard attend (camelCase + clubId + stats). Résultat : le vol existe
// dans Firebase mais reste invisible (Logbook ET Replay filtrent sur clubId).
//
// Ce trigger normalise tout doc firmware à l'écriture :
//   • résout clubId via la flotte — icao24 d'abord (id matériel fiable), immat ensuite
//   • mappe snake_case → camelCase (aircraftIdent, aircraftType…)
//   • parse le CSV Storage → startTs/endTs/duration/maxAlt/maxSpd/maxG/maxRpm/bounds
//     (même schéma que l'upload manuel ReplayPage → les deux pages marchent sans patch)
//   • pré-résout pilote/instructeur par PIN si non ambigu, laisse validated=false
//     (l'admin confirme l'assignation depuis le carnet)
// Idempotent : on ne touche que les docs `aircraft_ident` && !_normalized, et on
// pose _normalized=true → la ré-écriture de merge ne reboucle pas.

const norm = (s) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')

// Parse minimal d'un CSV Garmin G3X (3 lignes d'en-tête) → stats. Best-effort.
function parseG3XStats(text) {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length < 4) throw new Error('too few lines')
  const headers = lines[2].split(',').map((h) => h.trim())
  const idx = (name) => headers.indexOf(name)
  const iDate = idx('UTC Date'), iTime = idx('UTC Time')
  const iAltG = idx('AltGPS'),   iAltI = idx('AltInd')
  const iIas = idx('IAS'),       iGs = idx('GndSpd')
  const iNz = idx('NormAc'),     iRpm = idx('E1 RPM')
  const iLat = idx('Latitude'),  iLon = idx('Longitude')
  const numAt = (parts, i) => {
    if (i < 0) return null
    const v = parseFloat(parts[i])
    return isNaN(v) ? null : v
  }
  let startTs = null, endTs = null
  let maxAlt = -Infinity, maxSpd = -Infinity, maxG = -Infinity, maxRpm = -Infinity
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity
  for (let i = 3; i < lines.length; i++) {
    const parts = lines[i].split(',')
    if (parts.length < 10) continue
    const ds = iDate >= 0 ? (parts[iDate] || '').trim() : ''
    const tk = iTime >= 0 ? (parts[iTime] || '').trim() : ''
    if (!ds || !tk) continue
    const ts = new Date(`${ds}T${tk}Z`).getTime()
    if (isNaN(ts)) continue
    const lat = numAt(parts, iLat), lon = numAt(parts, iLon)
    if (lat === 0 && lon === 0) continue
    if (startTs === null) startTs = ts
    endTs = ts
    const altI = numAt(parts, iAltI), altG = numAt(parts, iAltG)
    const alt = altI != null ? altI : altG                 // baro si dispo, sinon GPS
    if (alt != null && alt > maxAlt) maxAlt = alt
    const ias = numAt(parts, iIas)
    const spd = ias != null ? ias : numAt(parts, iGs)
    if (spd != null && spd > maxSpd) maxSpd = spd
    const nz = numAt(parts, iNz)
    if (nz != null && Math.abs(nz) > maxG) maxG = Math.abs(nz)
    const rpm = numAt(parts, iRpm)
    if (rpm != null && rpm > maxRpm) maxRpm = rpm
    if (lat != null) { if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat }
    if (lon != null) { if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon }
  }
  if (startTs === null) throw new Error('no data rows')
  return {
    startTs, endTs,
    duration: Math.round((endTs - startTs) / 1000),
    maxAlt: isFinite(maxAlt) ? Math.round(maxAlt) : null,
    maxSpd: isFinite(maxSpd) ? Math.round(maxSpd) : null,
    maxG:   isFinite(maxG)   ? Math.round(maxG * 10) / 10 : null,
    maxRpm: isFinite(maxRpm) ? Math.round(maxRpm) : null,
    bounds: isFinite(minLat) ? { minLat, maxLat, minLon, maxLon } : null,
  }
}

// Résout le club d'un vol via la flotte. icao24 prioritaire (id transpondeur,
// plus fiable qu'une immat de test), puis immat normalisée.
async function resolveClubByAircraft(db, icao24, reg) {
  const icaoN = norm(icao24), regN = norm(reg)
  const snap = await db.collection('aircraft').get()
  let byIcao = null, byReg = null
  for (const d of snap.docs) {
    const a = d.data()
    if (a.archived === true) continue
    if (icaoN && norm(a.icao24) === icaoN) byIcao = a
    if (regN && norm(a.registration) === regN) byReg = a
  }
  const m = byReg || byIcao                                // immat exacte > icao
  return m ? { clubId: m.clubId || null, registration: m.registration || reg } : null
}

// PIN → pilote, uniquement si le match est unique dans le club (sinon admin).
async function resolvePilotByPin(db, clubId, pin) {
  if (!clubId || !pin) return null
  const snap = await db.collection('pilots')
    .where('clubId', '==', clubId).where('pin', '==', String(pin)).get()
  const cands = snap.docs.filter((d) => d.data().archived !== true)
  if (cands.length !== 1) return null
  return { id: cands[0].id, isInstructor: cands[0].data().isInstructor === true }
}

async function normalizeFlightDoc(db, flightId, data) {
  const resolved = await resolveClubByAircraft(db, data.icao24, data.aircraft_ident)
  const clubId = resolved?.clubId || null
  const aircraftIdent = resolved?.registration || data.aircraft_ident || null

  let stats = null
  try {
    const path = data.csvStoragePath || `flights/${data.flight_id}.csv`
    let [buf] = await getStorage().bucket(STORAGE_BUCKET).file(path).download()
    if (buf && buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf)
    stats = parseG3XStats(buf.toString('utf8'))
  } catch (e) {
    console.warn(`normalizeFlight ${flightId}: CSV parse failed: ${e.message}`)
  }

  const endMs = Number(data.end_ts) ? Number(data.end_ts) * 1000 : null
  const startTs = stats?.startTs ?? endMs
  const endTs   = stats?.endTs   ?? endMs

  const pilot      = data.pilot_code ? await resolvePilotByPin(db, clubId, data.pilot_code) : null
  const instructor = data.instr_code ? await resolvePilotByPin(db, clubId, data.instr_code) : null

  const patch = {
    clubId,
    aircraftIdent,
    aircraftType: data.aircraft_type || null,
    icao24: data.icao24 || null,
    fileName: (data.csvStoragePath || `${data.flight_id || flightId}.csv`).split('/').pop(),
    pilotId: pilot?.id || null,
    pilotRole: data.pilot_role || (pilot ? (pilot.isInstructor ? 'pilot' : 'pilot') : null),
    instructorId: instructor?.id || null,
    instructorOnboard: instructor ? true : null,
    flightType: null,
    validated: false,                                      // l'admin assigne depuis le carnet
    startTs, endTs,
    duration: stats?.duration ?? 0,
    maxAlt: stats?.maxAlt ?? null,
    maxSpd: stats?.maxSpd ?? null,
    maxG:   stats?.maxG ?? null,
    maxRpm: stats?.maxRpm ?? null,
    bounds: stats?.bounds ?? null,
    _normalized: true,
    normalizedAt: FieldValue.serverTimestamp(),
  }
  await db.collection('flights').doc(flightId).set(patch, { merge: true })
  console.log(`normalizeFlight ${flightId}: club=${clubId} ac=${aircraftIdent} start=${startTs} dur=${patch.duration} maxAlt=${patch.maxAlt}`)
}

exports.normalizeFlight = onDocumentWritten(
  { document: 'flights/{flightId}', region: 'europe-west1' },
  async (event) => {
    const after = event.data?.after?.data() || null
    if (!after) return                                     // doc supprimé
    if (!after.aircraft_ident) return                      // doc dashboard-natif (camelCase) → ignore
    if (after._normalized === true) return                 // déjà normalisé → anti-loop
    await normalizeFlightDoc(getFirestore(), event.params.flightId, after)
  }
)

// ─── Nettoyage Storage à la suppression d'un vol ──────────────────────────────
// La suppression du doc /flights (admin, depuis le carnet) ne supprime pas les
// CSV sur Storage → ce trigger efface les objets associés pour éviter les orphelins.
// Best-effort : un objet déjà absent (vol jamais uploadé, ou LTE désactivé) est ignoré.
exports.onFlightDeleted = onDocumentDeleted(
  { document: 'flights/{flightId}', region: 'europe-west1' },
  async (event) => {
    const data = event.data?.data() || {}
    const fid = data.flight_id || event.params.flightId
    const paths = [
      data.csvStoragePath    || `flights/${fid}.csv`,
      data.csvLteStoragePath || `flights_lte/${fid}.csv`,
    ]
    const bucket = getStorage().bucket(STORAGE_BUCKET)
    for (const p of paths) {
      try {
        await bucket.file(p).delete()
        console.log(`onFlightDeleted ${event.params.flightId}: removed ${p}`)
      } catch (e) {
        if (e.code !== 404) console.warn(`onFlightDeleted ${event.params.flightId}: ${p} → ${e.message}`)
      }
    }
  }
)

exports.safeskyTraffic = onRequest(
  { secrets: [SAFESKY_KEY], cors: true, region: 'europe-west1' },
  async (req, res) => {
    const { lat_min, lon_min, lat_max, lon_max } = req.query
    if (!lat_min || !lon_min || !lat_max || !lon_max) {
      return res.status(400).json({ error: 'Missing bounds params' })
    }
    const key = SAFESKY_KEY.value()

    try {
      const { default: fetch } = await import('node-fetch')
      const url = `https://uav-api.safesky.app/v1/uav?viewport=${lat_min},${lon_min},${lat_max},${lon_max}`
      const headers = generateAuthHeaders(key, 'GET', url)
      const response = await fetch(url, { method: 'GET', headers })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`SafeSky ${response.status} — ${text}`)
      }
      const data = await response.json()
      const traffic = Array.isArray(data) ? data : (data.nearby_traffic ?? [])
      res.json({ nearby_traffic: traffic })
    } catch (error) {
      console.error('SafeSky error:', error)
      res.status(500).json({ error: error.message })
    }
  }
)
