const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https')
const { onDocumentWritten, onDocumentDeleted } = require('firebase-functions/v2/firestore')
const { onSchedule } = require('firebase-functions/v2/scheduler')
const { defineSecret } = require('firebase-functions/params')
const { initializeApp, getApps } = require('firebase-admin/app')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')
const crypto = require('crypto')
const zlib = require('zlib')

const STORAGE_BUCKET = 'aerotrace-74217.firebasestorage.app'

if (getApps().length === 0) initializeApp()

const SAFESKY_KEY = defineSecret('SAFESKY_KEY')
const EMNIFY_APP_TOKEN = defineSecret('EMNIFY_APP_TOKEN')   // (P3) EMnify API application token

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
// ── Terrain le plus proche (OACI) d'une position ─────────────────────────────
// Base : aerodromes.json = fusion des 2 blobs ADP2 du firmware écran (3568 terrains,
// ICAO + lat/lon). Même source que l'écran → dashboard et écran restent cohérents.
// aerodromes.json est GÉNÉRÉ (écrasé à chaque régénération AIRAC) ; aerodromes_manual.json
// est saisi à la main et lui survit → il est fusionné ici et gagne à code OACI égal.
const AERODROMES = (() => {
  const byIcao = new Map()
  for (const a of require('./aerodromes.json').ads) byIcao.set(a[0], a)
  for (const a of require('./aerodromes_manual.json').ads) byIcao.set(a[0], a)
  return [...byIcao.values()]   // [[icao, lat, lon, type], ...]
})()

// Rayon max accepté. AU-DELÀ ON RENVOIE null, ET C'EST LE POINT CLÉ : sans plafond,
// un terrain absent de la base fait répondre le suivant "le moins loin" — mesuré à
// 59 km (Guernesey → LFAU) sur les vols de test. Mieux vaut "—" qu'un terrain faux.
// 5 km couvre le décalage entre le point de référence openAIP et le seuil de piste
// (max observé sur 45 départs justes : 1,86 km à ENZV).
const ICAO_MAX_KM = 5

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, r = Math.PI / 180
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/**
 * pos {lat,lon} → code OACI du terrain à moins de ICAO_MAX_KM, sinon null.
 * Le pré-filtre en boîte évite 3568 haversine par appel (~0.05° de lat ≈ 5,5 km ;
 * la longitude est élargie par 1/cos(lat) — indispensable en Islande où un degré de
 * longitude ne fait plus que ~48 km).
 */
function nearestIcao(pos) {
  if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lon)) return null
  const dLat = ICAO_MAX_KM / 111
  const dLon = dLat / Math.max(0.05, Math.cos(pos.lat * Math.PI / 180))
  let best = null, bestKm = Infinity
  for (const [icao, lat, lon] of AERODROMES) {
    if (Math.abs(lat - pos.lat) > dLat || Math.abs(lon - pos.lon) > dLon) continue
    const km = haversineKm(pos.lat, pos.lon, lat, lon)
    if (km < bestKm) { bestKm = km; best = icao }
  }
  return bestKm <= ICAO_MAX_KM ? best : null
}

/** "+02:00" | "-05:30" → minutes (120 | -330). null si illisible/absent. */
function parseUtcOffsetMin(s) {
  const m = /^([+-])(\d{1,2}):(\d{2})$/.exec((s || '').trim())
  if (!m) return null
  const min = parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
  return m[1] === '-' ? -min : min
}

function parseG3XStats(text) {
  const lines = text.split('\n').filter((l) => l.trim())
  if (lines.length < 4) throw new Error('too few lines')
  const headers = lines[2].split(',').map((h) => h.trim())
  const idx = (name) => headers.indexOf(name)
  // date/heure : AT-CORE écrit 'UTC Date'+'UTC Time' ; un G3X natif n'a PAS de 'UTC Date',
  // seulement 'Lcl Date'+'Lcl Time'+'UTCOfst' → on lit la paire locale et on retranche
  // l'offset. (Le G3X a bien une colonne 'UTC Time', mais sans date : l'associer à
  // 'Lcl Date' serait faux d'un jour quand l'offset fait franchir minuit.)
  const utcDate = idx('UTC Date')
  const isLocal = utcDate < 0
  const iDate = isLocal ? idx('Lcl Date') : utcDate
  const iTime = isLocal ? idx('Lcl Time') : idx('UTC Time')
  const iOfst = isLocal ? idx('UTCOfst')  : -1
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
  let startPos = null, endPos = null
  for (let i = 3; i < lines.length; i++) {
    const parts = lines[i].split(',')
    if (parts.length < 10) continue
    const ds = iDate >= 0 ? (parts[iDate] || '').trim() : ''
    const tk = iTime >= 0 ? (parts[iTime] || '').trim() : ''
    if (!ds || !tk) continue
    let ts = new Date(`${ds}T${tk}Z`).getTime()
    if (isNaN(ts)) continue
    if (isLocal) {
      const ofs = iOfst >= 0 ? parseUtcOffsetMin(parts[iOfst]) : null
      if (ofs !== null) ts -= ofs * 60000   // offset illisible → on garde tel quel
    }
    const lat = numAt(parts, iLat), lon = numAt(parts, iLon)
    if (lat === 0 && lon === 0) continue
    if (startTs === null) startTs = ts
    endTs = ts
    // 1re / dernière position fixée → terrain de départ / d'arrivée (cf nearestIcao)
    if (lat != null && lon != null) {
      if (!startPos) startPos = { lat, lon }
      endPos = { lat, lon }
    }
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
    depIcao: nearestIcao(startPos),
    arrIcao: nearestIcao(endPos),
  }
}

// Résout le club d'un vol via la flotte. icao24 prioritaire (id transpondeur,
// plus fiable qu'une immat de test), puis immat normalisée.
/**
 * Rattache un vol à un aéronef de la flotte. `reg` = ce que l'appareil a émis, qui peut
 * être l'immat OU l'indicatif (un G3X écrit son callsign : "FJFVB"), voire une valeur de
 * test. On accepte donc les 3 alias, par ordre de confiance :
 *   immat exacte > indicatif (callSign) > icao24.
 * Le callSign est indispensable : sans lui, un boîtier qui émet "FJFVB" ne se rattachait
 * que par l'icao24 — or les ULM sans transpondeur n'en ont pas (FW v67 : plus de hex
 * fabriqué) → le vol serait parti avec clubId=null, donc invisible au carnet.
 * Retourne TOUJOURS l'immat canonique de la flotte : c'est la clé de filtrage du carnet
 * (l'affichage, lui, préfère le callSign côté dashboard).
 */
async function resolveClubByAircraft(db, icao24, reg) {
  const icaoN = norm(icao24), regN = norm(reg)
  const snap = await db.collection('aircraft').get()
  let byIcao = null, byReg = null, byCall = null
  for (const d of snap.docs) {
    const a = d.data()
    if (a.archived === true) continue
    if (icaoN && norm(a.icao24) === icaoN) byIcao = a
    if (regN && norm(a.registration) === regN) byReg = a
    if (regN && norm(a.callSign) === regN) byCall = a
  }
  const m = byReg || byCall || byIcao
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
    // Terrains déduits de la 1re / dernière position GPS (null si rien à <5 km : le
    // boîtier n'a pas cette info, et un terrain hors base donnerait un faux — cf nearestIcao).
    depIcao: stats?.depIcao ?? null,
    arrIcao: stats?.arrIcao ?? null,
    _normalized: true,
    normalizedAt: FieldValue.serverTimestamp(),
  }
  await db.collection('flights').doc(flightId).set(patch, { merge: true })
  console.log(`normalizeFlight ${flightId}: club=${clubId} ac=${aircraftIdent} start=${startTs} dur=${patch.duration} maxAlt=${patch.maxAlt} ${patch.depIcao || '?'}->${patch.arrIcao || '?'}`)
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

// ─── Contrôle d'accès web « personnes désignées » (allowlist / invitation) ─────
// Appelé par le dashboard à chaque login. Provisionne l'utilisateur CÔTÉ SERVEUR
// (admin SDK, bypass des règles) uniquement s'il a été INVITÉ par un admin :
//   invites/{email}  →  { clubId, role, invitedByEmail, ... }
// Retour : { authorized, role, clubId, email }.
//  - super_admin OU user déjà rattaché à un club  → authorized (inchangé).
//  - email présent dans invites/                  → provisionné + invite marquée acceptée.
//  - sinon                                        → authorized:false → écran « accès en attente ».
// AUCUN rôle/club n'est jamais écrit par le client → pas d'escalade de privilège possible.
exports.claimAccess = onCall({ region: 'europe-west1' }, async (req) => {
  const uid = req.auth?.uid
  const email = (req.auth?.token?.email || '').toLowerCase()
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required')

  const db = getFirestore()
  const userRef = db.doc(`users/${uid}`)
  const userSnap = await userRef.get()

  // Déjà autorisé : super_admin (multi-club) ou un clubId rattaché.
  if (userSnap.exists) {
    const u = userSnap.data()
    if (u.role === 'super_admin' || u.clubId) {
      return { authorized: true, role: u.role || 'user', clubId: u.clubId || '', email }
    }
  }

  // Invitation en attente pour cet email ?
  if (email) {
    const invRef = db.doc(`invites/${email}`)
    const invSnap = await invRef.get()
    if (invSnap.exists) {
      const inv = invSnap.data()
      const role = inv.role || 'user'
      const clubId = inv.clubId || ''
      await userRef.set({
        email,
        displayName: req.auth.token.name || userSnap.data()?.displayName || null,
        role, clubId,
        invitedBy: inv.invitedByEmail || null,
        provisionedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      await invRef.set({ status: 'accepted', acceptedUid: uid, acceptedAt: FieldValue.serverTimestamp() }, { merge: true })
      return { authorized: true, role, clubId, email }
    }
  }

  // Non désigné → accès en attente. On NE crée PAS de doc user (base propre).
  const u = userSnap.exists ? userSnap.data() : {}
  return { authorized: false, role: u.role || 'user', clubId: u.clubId || '', email }
})

// ============================================================
// (P3) EMnify — conso data LTE par boîtier + total du pool
// ------------------------------------------------------------
// Le boîtier remonte son ICCID dans /devices/{boxId} (firmware v105, AT+CICCID).
// Ici on interroge l'API EMnify (REST v1), on associe chaque endpoint SIM à un
// boîtier par ICCID, et on écrit la conso data dans /devices/{boxId} + un total
// dans /fleetMeta/emnify → affiché dans FLEET.
//
// Secret requis :  firebase functions:secrets:set EMNIFY_APP_TOKEN
//   (EMnify Portal → Integrations → API Tokens → "Application Token")
//
// ⚠️ Le SCHÉMA exact des stats EMnify peut varier selon l'offre — l'extraction
// du volume est DÉFENSIVE (essaie plusieurs chemins) et LOGUE le 1er payload
// brut : si la conso ressort à 0 au 1er run réel, ajuster extractVolumeBytes()
// d'après le log `[emnify] stats sample`.
const EMNIFY_BASE = 'https://cdn.emnify.net/api/v1'

async function emnifyAuth(appToken) {
  const r = await fetch(`${EMNIFY_BASE}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ application_token: appToken }),
  })
  if (!r.ok) throw new Error(`emnify auth ${r.status}: ${(await r.text()).slice(0, 200)}`)
  const j = await r.json()
  if (!j.auth_token) throw new Error('emnify auth: pas de auth_token')
  return j.auth_token
}

// Deux ICCID « matchent » si l'un est préfixe de l'autre (gère le check-digit
// 19 vs 20 chiffres, et les espaces éventuels).
function iccidMatch(a, b) {
  a = String(a || '').replace(/\D/g, '')
  b = String(b || '').replace(/\D/g, '')
  if (!a || !b) return false
  return a === b || a.startsWith(b) || b.startsWith(a)
}

// `GET /endpoint/{id}/stats` renvoie { current_month:{data:{volume(MB, STRING), cost(€),
// month, currency}}, last_month:{...}, last_hour:{...} } — pas d'historique long.
// Normalise un bloc current_month / last_month → { key:"2026-07", mb, cost } (ou null).
function monthBlock(b) {
  const d = b?.data
  if (!d?.month) return null
  return { key: String(d.month).slice(0, 7), mb: parseFloat(d.volume) || 0, cost: parseFloat(d.cost) || 0 }
}

// Conso data (MB) par jour PAR ENDPOINT depuis EMnify — LU EN DIRECT, rien stocké chez nous.
// ⚠️ Chemin PAR CARTE = `/endpoint/{id}/stats/daily` (le `/stats/daily?endpoint=` est org-wide !).
// ⚠️ La réponse contient une ligne récap `date:"TOTAL"` à EXCLURE. Pas de coût dans le daily.
// Renvoie { lastDayMB, lastDayDate, yearMB, overallMB }.
async function fetchDailyRollup(H, epId, year, today) {
  const url = `${EMNIFY_BASE}/endpoint/${epId}/stats/daily?start_date=2020-01-01&end_date=${today}`
  const r = await fetch(url, { headers: H })
  if (!r.ok) return { lastDayMB: 0, lastDayDate: '', yearMB: 0, overallMB: 0 }
  const arr = await r.json()
  let overall = 0, yr = 0, lastMB = 0, lastDate = ''
  for (const b of (Array.isArray(arr) ? arr : [])) {
    const date = b?.date || ''
    if (date === 'TOTAL' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue   // saute la ligne récap
    const mb = parseFloat(b?.data?.volume) || 0
    overall += mb
    if (date.startsWith(year)) yr += mb
    if (date > lastDate) { lastDate = date; lastMB = mb }
  }
  return {
    lastDayMB: Math.round(lastMB * 10) / 10, lastDayDate: lastDate,
    yearMB: Math.round(yr * 10) / 10, overallMB: Math.round(overall * 10) / 10,
  }
}

// Cœur de la synchro. Retourne un résumé { matched, total endpoints, usedMB… }.
async function runEmnifySync(appToken) {
  const db = getFirestore()
  const authToken = await emnifyAuth(appToken)
  const H = { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' }

  // 1) Liste des boîtiers de la flotte. Match par ICCID (firmware v105+) OU, en repli,
  //    par le NOM de l'endpoint EMnify qui contient le boxId (ex "ATC-CE276D (FJFVB)")
  //    → la conso remonte AVANT même que les boîtiers soient en v105.
  const devSnap = await db.collection('devices').get()
  const fleet = []   // { iccid, boxId, ref }
  devSnap.forEach(d => {
    fleet.push({ iccid: String(d.data().iccid || '').replace(/\D/g, ''), boxId: d.id, ref: d.ref })
  })
  const withIccid = fleet.filter(f => f.iccid).length

  // 2) Liste des endpoints EMnify (SIMs), paginée.
  const endpoints = []
  for (let page = 1; page <= 20; page++) {
    const r = await fetch(`${EMNIFY_BASE}/endpoint?page=${page}&per_page=100`, { headers: H })
    if (!r.ok) { if (page === 1) throw new Error(`emnify endpoints ${r.status}`); break }
    const arr = await r.json()
    if (!Array.isArray(arr) || arr.length === 0) break
    endpoints.push(...arr)
    if (arr.length < 100) break
  }

  // 3) Pour chaque endpoint matché → conso LUE EN DIRECT sur EMnify :
  //    mensuel (/stats : mois courant + précédent, MB + €) et journalier (/stats/daily :
  //    dernier jour / année / overall, MB). Aucun cumul stocké chez nous.
  const todayStr = new Date().toISOString().slice(0, 10)   // YYYY-MM-DD (UTC)
  const year = todayStr.slice(0, 4)
  let loggedSample = false
  let matched = 0, currency = 'EUR'
  const tot = { monthMB: 0, monthCost: 0, lastMonthMB: 0, lastMonthCost: 0, lastDayMB: 0, yearMB: 0, overallMB: 0 }
  const batch = db.batch()
  for (const ep of endpoints) {
    const iccid = ep?.sim?.iccid || ep?.iccid
    const epName = (ep?.name || '').toUpperCase()
    const box = (iccid && fleet.find(f => iccidMatch(f.iccid, iccid)))
             || fleet.find(f => f.boxId && epName.includes(f.boxId.toUpperCase()))
    if (!box) continue
    matched++

    const statusName = ep?.sim?.status?.description || ep?.status?.description || ''
    let cur = null, last = null
    try {
      const sr = await fetch(`${EMNIFY_BASE}/endpoint/${ep.id}/stats`, { headers: H })
      if (sr.ok) {
        const stats = await sr.json()
        if (!loggedSample) { console.log('[emnify] stats sample', JSON.stringify(stats).slice(0, 400)); loggedSample = true }
        cur = monthBlock(stats.current_month)
        last = monthBlock(stats.last_month)
        currency = stats.current_month?.data?.currency?.code || currency
      } else console.warn(`[emnify] stats ${ep.id} → ${sr.status}`)
    } catch (e) { console.warn('[emnify] stats err', ep.id, e.message) }

    let daily = { lastDayMB: 0, lastDayDate: '', yearMB: 0, overallMB: 0 }
    try { daily = await fetchDailyRollup(H, ep.id, year, todayStr) }
    catch (e) { console.warn('[emnify] daily err', ep.id, e.message) }

    const monthMB = cur?.mb || 0, monthCost = cur?.cost || 0
    tot.monthMB += monthMB; tot.monthCost += monthCost
    tot.lastMonthMB += last?.mb || 0; tot.lastMonthCost += last?.cost || 0
    tot.lastDayMB += daily.lastDayMB; tot.yearMB += daily.yearMB; tot.overallMB += daily.overallMB

    batch.set(box.ref, {
      dataUsageMB: Math.round(monthMB * 10) / 10,        // mois courant (colonne DATA)
      dataCost: Math.round(monthCost * 100) / 100,       // mois courant (colonne COST €)
      dataCostCur: currency,
      monthKey: cur?.key || todayStr.slice(0, 7),
      lastMonthMB: Math.round((last?.mb || 0) * 10) / 10,
      lastMonthCost: Math.round((last?.cost || 0) * 100) / 100,
      lastDayMB: daily.lastDayMB, lastDayDate: daily.lastDayDate,
      yearMB: daily.yearMB, overallMB: daily.overallMB,
      simStatus: statusName,
      emnifyEndpointId: ep.id,
      emnifyName: ep.name || '',
      dataUsageUpdatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
  }

  // 4) Récap flotte (cache d'affichage, écrasé à chaque run — 100% EMnify).
  //    poolTotalMB (barre %) reste saisi à la main (l'endpoint « pool » EMnify varie).
  const metaRef = db.doc('fleetMeta/emnify')
  batch.set(metaRef, {
    monthKey: todayStr.slice(0, 7), year, lastDayDate: todayStr,
    totalUsedMB: Math.round(tot.monthMB * 10) / 10,      // = mois courant (compat champ existant)
    totalCost: Math.round(tot.monthCost * 100) / 100,
    lastMonthMB: Math.round(tot.lastMonthMB * 10) / 10, lastMonthCost: Math.round(tot.lastMonthCost * 100) / 100,
    lastDayMB: Math.round(tot.lastDayMB * 10) / 10,
    yearMB: Math.round(tot.yearMB * 10) / 10,
    overallMB: Math.round(tot.overallMB * 10) / 10,
    currency,
    endpointCount: endpoints.length,
    matchedCount: matched,
    fleetWithIccid: withIccid,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true })

  await batch.commit()
  const summary = { endpoints: endpoints.length, matched,
    monthMB: Math.round(tot.monthMB * 10) / 10, monthCost: Math.round(tot.monthCost * 100) / 100,
    yearMB: Math.round(tot.yearMB * 10) / 10, overallMB: Math.round(tot.overallMB * 10) / 10,
    lastDayMB: Math.round(tot.lastDayMB * 10) / 10 }
  console.log('[emnify] sync', JSON.stringify(summary))
  return summary
}

// Callable admin — bouton « Rafraîchir la conso » dans FLEET.
exports.refreshEmnify = onCall({ region: 'europe-west1', secrets: [EMNIFY_APP_TOKEN] }, async (req) => {
  const uid = req.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required')
  const db = getFirestore()
  const role = (await db.doc(`users/${uid}`).get()).data()?.role
  if (!['admin', 'super_admin'].includes(role)) throw new HttpsError('permission-denied', 'Admin only')
  const token = EMNIFY_APP_TOKEN.value()
  if (!token) throw new HttpsError('failed-precondition', 'EMNIFY_APP_TOKEN non configuré')
  try { return await runEmnifySync(token) }
  catch (e) { console.error('[emnify] refresh', e); throw new HttpsError('internal', e.message) }
})

// Planifié — rafraîchit la conso 4×/jour (EMnify agrège de toute façon lentement).
exports.emnifyUsageScheduled = onSchedule(
  { region: 'europe-west1', schedule: 'every 6 hours', secrets: [EMNIFY_APP_TOKEN] },
  async () => {
    const token = EMNIFY_APP_TOKEN.value()
    if (!token) { console.warn('[emnify] scheduled: pas de token'); return }
    try { await runEmnifySync(token) } catch (e) { console.error('[emnify] scheduled', e) }
  })
