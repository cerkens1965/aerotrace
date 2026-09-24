const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https')
const { onDocumentWritten, onDocumentDeleted } = require('firebase-functions/v2/firestore')
const { onSchedule } = require('firebase-functions/v2/scheduler')
const { defineSecret } = require('firebase-functions/params')
const { initializeApp, getApps } = require('firebase-admin/app')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const { getStorage } = require('firebase-admin/storage')
const crypto = require('crypto')
const zlib = require('zlib')
// (24/09) Attribution d'un vol : règles PURES, éprouvées par `node test/attribution.js`.
// Elles vivent dans leur propre module pour être vérifiables sans déployer — ces heures
// partent dans des carnets de vol.
const { ownersOf, decideAttribution } = require('./attribution')

const STORAGE_BUCKET = 'aerotrace-74217.firebasestorage.app'

if (getApps().length === 0) initializeApp()

const SAFESKY_KEY = defineSecret('SAFESKY_KEY')
const FLYADSL_KEY = defineSecret('FLYADSL_KEY')   // clé courte FlyADSL (x-api-key, même que les boîtiers)
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
  // (23/09) ÉTUDE DU VOL — le G était réduit à un unique |max|, ce qui perdait le signe : un
  // −1,5 g (poussée négative, dimensionnante sur une cellule entoilée) ressortait comme « 1,5 ».
  // On garde donc le max ET le min SIGNÉS, leur instant, et la liste horodatée des écarts
  // notables (|nz − 1| > 0,8 g) : c'est elle qui permettra de POINTER les moments sur la trace.
  // Les limites n'interviennent pas ici : elles sont propres à l'avion (cf. normalizeFlightDoc).
  let gMax = -Infinity, gMin = Infinity, gMaxTs = null, gMinTs = null
  const gPeaks = []
  let spdSum = 0, spdN = 0
  let badFixes = 0, lastFix = null   // (23/09) points GPS écartés
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
    // (23/09) MÊME REJET DES POINTS ABERRANTS que le lecteur du dashboard : un fix retombé
    // à 0/0 (« null island ») ou un saut impossible faussait l'emprise du vol, donc la carte
    // ET les terrains de départ/arrivée déduits de la 1re et de la dernière position.
    const lat = numAt(parts, iLat), lon = numAt(parts, iLon)
    if (lat == null || lon == null) continue
    if (lat === 0 && lon === 0) { badFixes++; continue }
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) { badFixes++; continue }
    if (lastFix) {
      const dtS = Math.max((ts - lastFix.ts) / 1000, 0.25)
      const dLat = (lat - lastFix.lat) * 111320
      const dLon = (lon - lastFix.lon) * 111320 * Math.cos(lat * Math.PI / 180)
      if (Math.hypot(dLat, dLon) / dtS * 1.94384 > 600) { badFixes++; continue }
    }
    lastFix = { lat, lon, ts }
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
    if (spd != null && spd > 30) { spdSum += spd; spdN++ }   // moyenne EN VOL (roulage exclu)
    const nz = numAt(parts, iNz)
    if (nz != null) {
      if (Math.abs(nz) > maxG) maxG = Math.abs(nz)
      if (nz > gMax) { gMax = nz; gMaxTs = ts }
      if (nz < gMin) { gMin = nz; gMinTs = ts }
      if (Math.abs(nz - 1) > 0.8 && gPeaks.length < 400) gPeaks.push({ t: ts, g: Math.round(nz * 100) / 100 })
    }
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
    gMax:   isFinite(gMax)   ? Math.round(gMax * 100) / 100 : null,
    gMin:   isFinite(gMin)   ? Math.round(gMin * 100) / 100 : null,
    gMaxTs, gMinTs, gPeaks,
    avgSpd: spdN ? Math.round(spdSum / spdN) : null,
    maxRpm: isFinite(maxRpm) ? Math.round(maxRpm) : null,
    bounds: isFinite(minLat) ? { minLat, maxLat, minLon, maxLon } : null,
    badFixes,
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
  return m ? { clubId: m.clubId || null, registration: m.registration || reg,
               ownership: m.ownership || 'club', ownerPilotId: m.ownerPilotId || '',
               ownerPilotIds: ownersOf(m),                // (24/09) copropriété
               typeDesig: m.typeDesig || null } : null   // (2026-09-21) propriétaire · (23/09) type → limites
}

// (24/09, Christophe : « pourquoi garde-t-on encore ce code à 4 chiffres ? ») TRIGRAMME → pilote.
// Le code à 4 chiffres n'était qu'une clé de transport : personne ne le tape sur un avion en
// propriété, l'écran affiche des noms. Le trigramme est unique dans le club (l'Admin le vérifie),
// il est déjà partout, et un pilote sans code reste ainsi identifiable — l'absence de code ne
// peut plus faire disparaître quelqu'un en silence.
// Même exigence que pour le PIN : on n'attribue QUE si le match est unique.
async function resolvePilotByTrigram(db, clubId, trig) {
  if (!clubId || !trig) return null
  const t = String(trig).trim().toUpperCase()
  if (!t) return null
  const snap = await db.collection('pilots').where('clubId', '==', clubId).get()
  const cands = snap.docs.filter((d) => d.data().archived !== true
    && String(d.data().trigram || '').trim().toUpperCase() === t)
  if (cands.length !== 1) return null
  return { id: cands[0].id, isInstructor: cands[0].data().isInstructor === true }
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

  // Le code d'abord (chemin historique, et le clavier de l'avion club), le trigramme ensuite :
  // c'est lui que l'écran envoie quand le pilote a été choisi par son NOM dans la liste.
  // (24/09) L'IDENTIFIANT DE FICHE D'ABORD : il ne dépend ni du club ni d'une étiquette qu'on
  // peut renommer. Le code ensuite (clavier de l'avion club), le trigramme en dernier — les deux
  // restent lus pour les boîtiers qui n'ont pas encore la v228.
  let pilot = null
  if (data.pilot_id) {
    const ps = await db.doc(`pilots/${data.pilot_id}`).get()
    if (ps.exists && ps.data().archived !== true) pilot = { id: ps.id, isInstructor: ps.data().isInstructor === true }
  }
  if (!pilot && data.pilot_code)    pilot = await resolvePilotByPin(db, clubId, data.pilot_code)
  if (!pilot && data.pilot_trigram) pilot = await resolvePilotByTrigram(db, clubId, data.pilot_trigram)
  const instructor = data.instr_code ? await resolvePilotByPin(db, clubId, data.instr_code) : null

  // (2026-09-21, règle Christophe) AVION PROPRIÉTAIRE → le pilote EST le propriétaire, aucune attribution à faire.
  // Auto-validé en solo SAUF si le boîtier a identifié un autre pilote (PIN) ou un instructeur (vol d'instruction
  // sur avion privé) : ces cas restent dans la file « To assign », pré-remplis, pour décision humaine.
  //
  // (24/09) COPROPRIÉTÉ — l'automatisme ne s'arme QUE si la fiche ne désigne qu'un seul
  // propriétaire. À plusieurs, personne ne peut être crédité en silence : le vol part en
  // REVENDICATION (`claim`), chaque copropriétaire le voit et dit si c'est lui. Un carnet
  // qui crédite d'office la mauvaise personne ne se corrige qu'au prochain audit de licence
  // — on préfère un vol non attribué à un vol faussement attribué.
  const owners = resolved?.ownership === 'owner' ? (resolved.ownerPilotIds || []) : []
  const att    = decideAttribution(owners, pilot, instructor)

  // ── (23/09, demande Christophe) ÉTUDE DU VOL : dépassements de facteur de charge ──
  // GARDE-FOU VOULU : on n'évalue QUE des limites saisies pour CET avion et explicitement
  // CONFIRMÉES (limits.confirmed), avec leur source. Une limite absente ou non confirmée ne
  // déclenche rien — jamais de valeur par défaut, jamais de limite « de type » appliquée à
  // l'aveugle : une valeur fausse ici, c'est soit une alerte qui ne part pas, soit un vol
  // déclaré suspect à tort.
  // LA VITESSE N'EST PAS ÉVALUÉE (décision Christophe 23/09) : sans pitot, le CSV ne porte que
  // la vitesse SOL, qu'un vent arrière suffit à pousser au-delà de la Vne sans que la cellule
  // n'ait rien subi. Elle reste un relevé (avgSpd / maxSpd), pas une alerte.
  // (23/09, 2e passe — décision Christophe) Les limites sont portées par le TYPE
  // (`aircraftTypes/{désignateur OACI}`), pas par l'immatriculation : un club avec trois VL3
  // ne les saisit qu'une fois. Un type sans fiche, ou dont la fiche n'est pas confirmée,
  // n'arme rien.
  let lim = null
  if (resolved?.typeDesig) {
    try { const ts = await db.doc(`aircraftTypes/${resolved.typeDesig}`).get()
          if (ts.exists) lim = ts.data() } catch (e) { console.warn(`limits ${resolved.typeDesig}: ${e.message}`) }
  }
  const armed = !!(lim && lim.confirmed === true)
  const gPos = armed && Number.isFinite(Number(lim.gPos)) ? Number(lim.gPos) : null
  const gNeg = armed && Number.isFinite(Number(lim.gNeg)) ? Number(lim.gNeg) : null
  let gEvents = [], gState = armed ? 'ok' : 'unknown'
  if (stats && (gPos != null || gNeg != null)) {
    for (const pk of (stats.gPeaks || [])) {
      const over = (gPos != null && pk.g > gPos) || (gNeg != null && pk.g < gNeg)
      const near = !over && ((gPos != null && pk.g > gPos * 0.9) || (gNeg != null && pk.g < gNeg * 0.9))
      if (over || near) gEvents.push({ t: pk.t, g: pk.g, level: over ? 'over' : 'near' })
    }
    // Les plus sévères d'abord, 20 au plus : de quoi pointer les moments sans gonfler la fiche.
    gEvents.sort((a, b) => Math.abs(b.g - 1) - Math.abs(a.g - 1))
    gEvents = gEvents.slice(0, 20)
    gState = gEvents.some(e => e.level === 'over') ? 'over'
           : gEvents.length ? 'near' : 'ok'
  }

  const patch = {
    clubId,
    aircraftIdent,
    // Étude du vol (relevés + dépassements G) — recalculée à chaque normalisation.
    study: stats ? {
      avgSpd: stats.avgSpd ?? null,       // vitesse SOL moyenne en vol (> 30 kt), relevé seul
      maxSpd: stats.maxSpd ?? null,       // vitesse SOL max, relevé seul
      maxAlt: stats.maxAlt ?? null,
      gMax:   stats.gMax ?? null,         // signés : un −1,5 g ne doit pas se lire « 1,5 »
      gMin:   stats.gMin ?? null,
      gMaxTs: stats.gMaxTs ?? null,
      gMinTs: stats.gMinTs ?? null,
      badFixes: stats.badFixes ?? 0,      // points GPS écartés (0/0, hors domaine, saut > 600 kt)
      gState,                             // 'over' | 'near' | 'ok' | 'unknown' (seuils non confirmés)
      gLimits: armed ? { gPos, gNeg, type: resolved?.typeDesig || null, source: lim.source || null } : null,
      gEvents,
    } : null,
    aircraftType: data.aircraft_type || null,
    icao24: data.icao24 || null,
    fileName: (data.csvStoragePath || `${data.flight_id || flightId}.csv`).split('/').pop(),
    pilotId: att.pilotId,
    pilotRole: att.validated ? 'pilot' : (data.pilot_role || (pilot ? 'pilot' : null)),
    instructorId: instructor?.id || null,
    instructorOnboard: instructor ? true : null,
    flightType: att.validated ? 'solo' : null,
    validated: att.validated,                              // propriétaire → auto ; sinon l'admin/instructeur assigne depuis le carnet
    autoAssigned: att.autoAssigned,
    // (24/09) COMMENT on a su, jamais effacé ensuite : 'declared' = code saisi à l'avion (le
    // boîtier le sait), 'owner' = seul propriétaire, 'claimed' = revendiqué après le vol,
    // 'assigned' = posé au bureau. Le carnet ne doit pas présenter une déduction comme un fait.
    pilotSource: att.pilotSource,
    claim: att.claim,
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
  console.log(`normalizeFlight ${flightId}: club=${clubId} ac=${aircraftIdent} start=${startTs} dur=${patch.duration} maxAlt=${patch.maxAlt} ${patch.depIcao || '?'}->${patch.arrIcao || '?'} pilot=${att.pilotId || '∅'}/${att.pilotSource || 'none'}${att.claim ? ` claim=${att.claim.candidates.length}` : ''}`)
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
    // (2026-09-21) GARDE-FOU — incident 19/09 : deux fiches partageaient le même flight_id ; supprimer le doublon
    // a effacé la trace de l'AUTRE vol (perte du CSV EBBY→EDRA du 18/09). On n'efface un fichier QUE si plus
    // aucune fiche /flights ne le référence (même chemin, ou même flight_id pour les chemins par défaut).
    const db = getFirestore()
    const stillUsed = async (path) => {
      const q = [
        db.collection('flights').where('csvStoragePath', '==', path).limit(1).get(),
        db.collection('flights').where('csvLteStoragePath', '==', path).limit(1).get(),
      ]
      if (data.flight_id) q.push(db.collection('flights').where('flight_id', '==', data.flight_id).limit(1).get())
      const snaps = await Promise.all(q)
      return snaps.some(sn => !sn.empty)
    }
    for (const p of paths) {
      if (await stillUsed(p)) { console.warn(`onFlightDeleted ${event.params.flightId}: ${p} KEPT — still referenced by another flight`); continue }
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

// ─── (2026-08-31, « Pourquoi ce n'est pas automatique ? ») SYNC fiche aéronef → boîtier ──────
// La fiche (collection aircraft, éditée au dashboard Admin) est la SOURCE ; ce trigger reporte
// automatiquement reg/type/hex vers /deviceConfigPublic/{boxId} du boîtier dont le callSign
// correspond (rapporté dans /devices) → plus AUCUNE double saisie Fleet ✎. Écrit via l'admin
// SDK (bypass règles). Garde-fous : ne réagit qu'aux champs d'identité (pas aux photos), ne
// réécrit que si différent, ne TOUCHE PAS au WiFi (doc auth /deviceConfig).
async function syncAircraftToBox(after, tag) {
  const cs  = String(after.callSign || after.registration || '').trim().toUpperCase()
  if (!cs) return []
  const hex  = String(after.icao24 || '').trim().toUpperCase()
  const type = String(after.typeDesig || '').trim().toUpperCase()
  const db = getFirestore()
  // (2026-09-20) PILOTE PAR DÉFAUT : avion en propriété privée (ownership 'owner') → trigramme du pilote
  // propriétaire poussé au boîtier (« owner ») → affiché par l'écran comme pilote par défaut (AirKi View v274).
  //
  // (24/09) COPROPRIÉTÉ : `owners` = TOUS les trigrammes, pour que l'écran puisse demander
  // « qui pilote ? » en une pression. `owner` (pilote par défaut) n'est renseigné que s'il
  // n'y en a QU'UN : à plusieurs, pré-remplir un nom, c'est refaire la supposition qu'on
  // cherche à éviter. Trigrammes seulement, jamais les noms : ce document est PUBLIC en
  // lecture (le boîtier le lit sans jeton, cf. règle deviceConfigPublic).
  let owner = ''
  let owners = []
  let ownerIds = []
  if (after.ownership === 'owner') {
    const ids = ownersOf(after)
    ownerIds = ids            // (24/09) l'identifiant de fiche ne change jamais, le trigramme si
    for (const id of ids) {
      try { const ps = await db.doc(`pilots/${id}`).get()
            const tg = String(ps.data()?.trigram || '').trim().toUpperCase().slice(0, 3)
            if (tg) owners.push(tg) } catch (e) { console.warn('[syncAircraft] owner lookup', e) }
    }
    if (owners.length === 1) owner = owners[0]
  }
  const devs = await db.collection('devices').where('callSign', '==', cs).get()
  const done = []
  for (const d of devs.docs) {
    const boxId = d.data().boxId || d.id
    const ref = db.doc(`deviceConfigPublic/${boxId}`)
    const cur = (await ref.get()).data() || {}
    const sameOwners = (cur.owners || []).join(',') === owners.join(',')
                    && (cur.ownerIds || []).join(',') === ownerIds.join(',')
    if (cur.reg === cs && (cur.hex || '') === hex && (cur.type || '') === type && (cur.owner || '') === owner && sameOwners) continue
    await ref.set({
      boxId, reg: cs, type, hex, owner, owners, ownerIds,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: `auto-sync fiche aéronef (${tag})`,
    }, { merge: true })
    console.log(`[syncAircraft] ${cs} → ${boxId}: hex=${hex} type=${type} owner=${owner || '∅'} owners=${owners.join('/') || '∅'}`)
    done.push(`${cs}→${boxId}:${hex || '∅'}`)
  }
  return done
}

exports.syncAircraftIdentity = onDocumentWritten(
  { document: 'aircraft/{acId}', region: 'europe-west1' },
  async (event) => {
    const before = event.data?.before?.data() || null
    const after  = event.data?.after?.data()  || null
    if (!after) return                                       // suppression → rien

    // (24/09) MIGRATION EN DOUCEUR vers la copropriété. `ownerPilotIds` devient la source ;
    // `ownerPilotId` est tenu sur le PREMIER nom parce que tout le dashboard le lit encore
    // (fiche avion, règle propriétaire du carnet, noms de la page In flight). Une fiche
    // ancienne se convertit d'elle-même à sa première écriture — pas de script à lancer, pas
    // de fenêtre où les deux champs se contredisent. La ré-écriture redéclenche ce trigger
    // UNE fois, puis converge : la deuxième passe ne trouve plus rien à corriger.
    const want = ownersOf(after)
    const curIds = Array.isArray(after.ownerPilotIds) ? after.ownerPilotIds : null
    if (want.length && (!curIds || curIds.join('|') !== want.join('|')
                        || String(after.ownerPilotId || '') !== want[0])) {
      await getFirestore().doc(`aircraft/${event.params.acId}`)
        .set({ ownerPilotIds: want, ownerPilotId: want[0] }, { merge: true })
      console.log(`[syncAircraft] ${event.params.acId}: owners alignés → ${want.join('/')}`)
    }

    // (24/09) PLUS DE SORTIE ANTICIPÉE SUR « RIEN N'A CHANGÉ DANS LA FICHE ».
    // Elle comparait la fiche à elle-même et s'arrêtait là — donc un document de config
    // INCOMPLET côté boîtier (par exemple sans ownerIds, ajouté depuis) ne se réparait jamais :
    // ré-enregistrer la fiche ne faisait rien, et il fallait un backfill manuel.
    // syncAircraftToBox compare déjà ce qui est POUSSÉ à ce qu'il faudrait pousser, et n'écrit
    // que si ça diffère : la garde ci-dessus n'économisait qu'une lecture, au prix d'un état
    // dont on ne pouvait pas sortir. Toute écriture sur la fiche revérifie donc la config.
    await syncAircraftToBox(after, event.params.acId)
  }
)

// (24/09, Christophe : « son trigramme est affiché, plus son nom ») LE TRIGRAMME D'UN PILOTE
// CHANGE, LES BOÎTIERS DOIVENT LE SAVOIR.
// La liste des propriétaires poussée aux boîtiers est faite de TRIGRAMMES — une étiquette qui
// appartient au pilote, pas à l'avion. Or la sync ne se déclenchait que sur la fiche AVION :
// renommer un pilote (PLE → PTO) laissait les boîtiers avec un trigramme qui n'existe plus, et
// l'écran, ne sachant plus le résoudre, affichait le code brut à la place du nom.
// On réagit donc aussi aux fiches PILOTE, et uniquement au champ qui compte.
exports.syncPilotTrigram = onDocumentWritten(
  { document: 'pilots/{pilotId}', region: 'europe-west1' },
  async (event) => {
    const before = event.data?.before?.data() || null
    const after  = event.data?.after?.data()  || null
    if (!after || !before) return                      // création / suppression : rien à resynchroniser
    const was = String(before.trigram || '').trim().toUpperCase()
    const now = String(after.trigram  || '').trim().toUpperCase()
    if (was === now) return

    const db = getFirestore()
    const pilotId = event.params.pilotId
    // Les fiches des deux générations : tableau (copropriété) et champ historique.
    const [byList, byLegacy] = await Promise.all([
      db.collection('aircraft').where('ownerPilotIds', 'array-contains', pilotId).get(),
      db.collection('aircraft').where('ownerPilotId', '==', pilotId).get(),
    ])
    const seen = new Set()
    const done = []
    for (const d of [...byList.docs, ...byLegacy.docs]) {
      if (seen.has(d.id)) continue
      seen.add(d.id)
      if (d.data().archived === true) continue
      done.push(...await syncAircraftToBox(d.data(), `trigram ${was}→${now}`))
    }
    console.log(`syncPilotTrigram ${pilotId}: ${was || '∅'} → ${now || '∅'} · ${seen.size} aéronef(s) resynchronisé(s) ${done.join(' ') || ''}`)
  }
)

// Backfill ONE-SHOT (idempotent, bénin — ne fait que rejouer la sync sur l'existant) :
// GET /backfillIdentity → applique syncAircraftToBox à TOUTES les fiches. Utilisé le 31/08
// pour rattraper les boîtiers dont la fiche avait déjà le hex AVANT la mise en place du trigger.
exports.backfillIdentity = onRequest({ region: 'europe-west1' }, async (req, res) => {
  try {
    const snap = await getFirestore().collection('aircraft').get()
    const out = []
    for (const doc of snap.docs) out.push(...await syncAircraftToBox(doc.data(), `backfill/${doc.id}`))
    res.json({ synced: out })
  } catch (e) { console.error('backfill error:', e); res.status(500).json({ error: e.message }) }
})

// ─── (2026-08-31) Proxy photo airport-data.com — PAS de CORS chez eux → rewrite Hosting
// /api/acphoto?r=OO-I44 → { photo: {url, credit, link} | null }. Couverture ULM belges
// excellente (OO-I44/I43/H63/I35/H14 vérifiés), complète planespotters côté dashboard.
// Cache CDN 24 h (Cache-Control) : une immat est stable, pas besoin de re-fetch.
exports.acPhoto = onRequest({ region: 'europe-west1', cors: true }, async (req, res) => {
  const r = String(req.query.r || '').trim().toUpperCase()
  if (!/^[A-Z0-9-]{3,10}$/.test(r)) return res.status(400).json({ error: 'bad reg' })
  try {
    const { default: fetch } = await import('node-fetch')
    const resp = await fetch(`https://airport-data.com/api/ac_thumb.json?r=${encodeURIComponent(r)}&n=1`,
      { headers: { 'User-Agent': 'AeroTrace-Dashboard/1.0 (aerotrace-74217.web.app)' } })
    const j = await resp.json().catch(() => null)
    const d = j && j.status === 200 && Array.isArray(j.data) ? j.data[0] : null
    res.set('Cache-Control', 'public, max-age=86400')
    res.json({ photo: d ? { url: d.image || '', credit: d.photographer || '', link: d.link || '' } : null })
  } catch (e) {
    console.error('acPhoto error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ─── (2026-08-31) Proxy hex LIVE adsb.lol — indicatif radio → hex Mode S, marche UNIQUEMENT
// pendant que l'avion émet (le transpondeur broadcast son Flight ID, ex "FJVUD" → hex 38C37C ;
// c'est ainsi que FR24 fait le lien). adsb.lol n'a pas de CORS → rewrite /api/hexlive?q=FJVUD.
// Essaie callsign PUIS registration. Réponse: { hex, callsign } | { hex: null }.
exports.hexLive = onRequest({ region: 'europe-west1', cors: true }, async (req, res) => {
  const q = String(req.query.q || '').trim().toUpperCase()
  if (!/^[A-Z0-9-]{3,10}$/.test(q)) return res.status(400).json({ error: 'bad query' })
  try {
    const { default: fetch } = await import('node-fetch')
    for (const path of [`callsign/${encodeURIComponent(q)}`, `reg/${encodeURIComponent(q)}`]) {
      const j = await (await fetch(`https://api.adsb.lol/v2/${path}`,
        { headers: { 'User-Agent': 'AeroTrace-Dashboard/1.0 (aerotrace-74217.web.app)' } })).json().catch(() => null)
      const ac = j && Array.isArray(j.ac) ? j.ac[0] : null
      if (ac && /^[0-9a-f]{6}$/i.test(ac.hex || '')) {
        res.set('Cache-Control', 'public, max-age=60')
        return res.json({ hex: ac.hex.toUpperCase(), callsign: (ac.flight || '').trim() })
      }
    }
    res.set('Cache-Control', 'public, max-age=60')
    res.json({ hex: null })
  } catch (e) {
    console.error('hexLive error:', e)
    res.status(500).json({ error: e.message })
  }
})

// ─── Statut « En vol » de la flotte via FlyADSL /v1/beacons/search ─────────────
// Le flux uav-api /v1/uav ne contient QUE les sources radio (ADS-B/Mode-S/FLARM) —
// jamais les membres RÉSEAU (app SafeSky, balises ADS-L AeroTrace). FlyADSL expose
// en revanche la recherche de balise live PAR CALLSIGN, toutes sources réseau
// confondues et SANS limite de viewport (un membre en voyage reste visible).
// Auth : header x-api-key (même clé que le registry / les boîtiers).
// GET /safesky/fleet?call_signs=FJMLV,OOI43,... → { beacons: { FJMLV: {...}, ... } }
exports.fleetBeacons = onRequest(
  { secrets: [FLYADSL_KEY], cors: true, region: 'europe-west1' },
  async (req, res) => {
    const raw = (req.query.call_signs || '').toString()
    const signs = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 20)
    if (!signs.length) return res.status(400).json({ error: 'Missing call_signs' })
    const key = FLYADSL_KEY.value()
    try {
      const { default: fetch } = await import('node-fetch')
      const out = {}
      await Promise.all(signs.map(async cs => {
        try {
          const r = await fetch(
            `https://api.flyadsl.com/v1/beacons/search?call_sign=${encodeURIComponent(cs)}`,
            { headers: { 'x-api-key': key } })
          if (!r.ok) return                    // 404 = pas de balise live pour ce callsign
          const b = await r.json()
          if (b && b.call_sign) out[b.call_sign.toUpperCase()] = b
        } catch (e) { /* best-effort par callsign */ }
      }))
      res.set('Cache-Control', 'no-store')
      res.json({ beacons: out })
    } catch (error) {
      console.error('fleetBeacons error:', error)
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
// ─── (2026-09-21) CODES D'INVITATION PILOTE ─────────────────────────────────
// L'e-mail n'est pas une clé fiable (adresse Google ≠ adresse de la fiche, relais Apple « masquer mon e-mail »).
// L'admin génère un code à usage unique POUR UNE FICHE PILOTE ; le pilote se connecte avec n'importe quel compte,
// saisit le code → son compte est rattaché au club ET relié à sa fiche (users/{uid}.pilotId, pilots/{id}.uid).
// Collection inviteCodes/{code} : AUCUNE règle Firestore → illisible/inscriptible par les navigateurs, admin SDK seul.
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'   // sans 0/O/1/I : lisible à l'oral et à l'écran
const INVITE_TTL_MS = 14 * 24 * 3600 * 1000
function newInviteCode() {
  const b = require('crypto').randomBytes(8); let c = ''
  for (let i = 0; i < 8; i++) c += INVITE_ALPHABET[b[i] % INVITE_ALPHABET.length]
  return `${c.slice(0, 4)}-${c.slice(4)}`
}
const normInviteCode = (x) => {
  const c = String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : ''
}

// Admin (ou super_admin) → code pour une fiche pilote de SON club. Les codes non utilisés précédents sont révoqués.
exports.createPilotInvite = onCall({ region: 'europe-west1' }, async (req) => {
  const uid = req.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required')
  const db = getFirestore()
  const me = (await db.doc(`users/${uid}`).get()).data() || {}
  if (me.role !== 'admin' && me.role !== 'super_admin') throw new HttpsError('permission-denied', 'Admin only')
  const pilotId = String(req.data?.pilotId || '')
  const pSnap = pilotId ? await db.doc(`pilots/${pilotId}`).get() : null
  if (!pSnap || !pSnap.exists || pSnap.data().archived === true) throw new HttpsError('not-found', 'Pilot not found')
  const p = pSnap.data()
  if (me.role !== 'super_admin' && p.clubId !== me.clubId) throw new HttpsError('permission-denied', 'Pilot is not in your club')
  const old = await db.collection('inviteCodes').where('pilotId', '==', pilotId).where('usedBy', '==', null).get()
  const batch = db.batch()
  old.docs.forEach((d) => batch.set(d.ref, { revoked: true, revokedAt: FieldValue.serverTimestamp() }, { merge: true }))
  let code = newInviteCode()
  for (let i = 0; i < 5 && (await db.doc(`inviteCodes/${code}`).get()).exists; i++) code = newInviteCode()
  const expiresAt = Date.now() + INVITE_TTL_MS
  batch.set(db.doc(`inviteCodes/${code}`), {
    clubId: p.clubId || '', pilotId, trigram: p.trigram || '',
    role: p.isInstructor === true ? 'instructor' : 'user',
    createdBy: me.email || uid, createdAt: FieldValue.serverTimestamp(), expiresAt,
    usedBy: null, revoked: false,
  })
  await batch.commit()
  console.log(`createPilotInvite ${code} → pilot ${pilotId} (${p.trigram || '?'}) club=${p.clubId} by ${me.email || uid}`)
  return { code, expiresAt }
})

// Pilote connecté (tout fournisseur) → saisit le code. Transaction : un code ne sert qu'une fois.
// Ne rétrograde jamais un admin/super_admin existant ; relie compte ↔ fiche dans les deux sens.
exports.redeemInvite = onCall({ region: 'europe-west1' }, async (req) => {
  const uid = req.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required')
  const code = normInviteCode(req.data?.code)
  if (!code) throw new HttpsError('invalid-argument', 'The code has 8 characters, for example ABCD-2345.')
  const db = getFirestore()
  const email = (req.auth?.token?.email || '').toLowerCase()
  const out = await db.runTransaction(async (tx) => {
    const cRef = db.doc(`inviteCodes/${code}`)
    const c = await tx.get(cRef)
    if (!c.exists) throw new HttpsError('not-found', 'This code does not exist. Check it with your club admin.')
    const d = c.data()
    if (d.revoked) throw new HttpsError('failed-precondition', 'This code has been replaced by a newer one. Ask your club admin.')
    if (d.usedBy && d.usedBy !== uid) throw new HttpsError('already-exists', 'This code has already been used.')
    if (Number(d.expiresAt) < Date.now()) throw new HttpsError('deadline-exceeded', 'This code has expired. Ask your club admin for a new one.')
    const uRef = db.doc(`users/${uid}`), pRef = db.doc(`pilots/${d.pilotId}`)
    const [uSnap, pSnap] = await Promise.all([tx.get(uRef), tx.get(pRef)])
    if (!pSnap.exists) throw new HttpsError('not-found', 'The pilot profile no longer exists.')
    const cur = uSnap.exists ? uSnap.data() : {}
    const keepRole = cur.role === 'admin' || cur.role === 'super_admin'
    const role = keepRole ? cur.role : (d.role || 'user')
    const clubId = cur.role === 'super_admin' ? (cur.clubId || d.clubId) : d.clubId
    tx.set(uRef, {
      email: email || cur.email || null,
      displayName: req.auth.token.name || cur.displayName || null,
      role, clubId, pilotId: d.pilotId, linkedBy: 'invite-code', linkedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    tx.set(pRef, { uid, accountEmail: email || null, linkedAt: FieldValue.serverTimestamp() }, { merge: true })
    tx.set(cRef, { usedBy: uid, usedEmail: email || null, usedAt: FieldValue.serverTimestamp() }, { merge: true })
    return { authorized: true, role, clubId, pilotId: d.pilotId, trigram: d.trigram || '' }
  })
  console.log(`redeemInvite ${code} → uid ${uid} (${email || 'no email'}) pilot ${out.pilotId} role=${out.role}`)
  return out
})

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

// ─── (24/09) REVENDICATION D'UN VOL — copropriété ────────────────────────────────
// Un vol sur avion détenu à plusieurs n'est attribué à personne : chaque copropriétaire le
// voit et répond. Cette fonction est le SEUL chemin d'écriture pour un pilote — les règles
// Firestore réservent l'écriture des vols aux instructeurs et admins, et c'est très bien :
// on ne veut pas qu'un compte puisse s'attribuer un vol quelconque depuis le navigateur.
// Ici l'admin SDK écrit, après avoir vérifié que l'appelant est bien l'un des candidats.
//
// `mine: false` sert deux fois : récuser un vol qu'on ne revendique pas (il part dans la file
// d'attribution une fois que tous ont dit non), et RENDRE un vol auto-attribué — le cas du
// propriétaire qui prête son appareil et à qui on crédite des heures qu'il n'a pas volées.
//
// Premier arrivé, premier servi. Une deuxième revendication ne vole pas le vol au premier :
// elle marque un CONFLIT, que l'admin tranche depuis le carnet.
exports.claimFlight = onCall({ region: 'europe-west1' }, async (req) => {
  const uid = req.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required')
  const flightId = String(req.data?.flightId || '')
  if (!flightId) throw new HttpsError('invalid-argument', 'flightId is required')
  const mine = req.data?.mine !== false          // défaut : je revendique

  const db = getFirestore()
  const me = (await db.doc(`users/${uid}`).get()).data() || {}
  const myPilotId = String(me.pilotId || '')
  if (!myPilotId) throw new HttpsError('failed-precondition', 'Your account is not linked to a pilot profile yet.')

  const out = await db.runTransaction(async (tx) => {
    const fRef = db.doc(`flights/${flightId}`)
    const fSnap = await tx.get(fRef)
    if (!fSnap.exists) throw new HttpsError('not-found', 'This flight no longer exists.')
    const f = fSnap.data()
    if (f.archived === true) throw new HttpsError('failed-precondition', 'This flight is archived.')
    if (me.role !== 'super_admin' && f.clubId && me.clubId && f.clubId !== me.clubId) {
      throw new HttpsError('permission-denied', 'This flight belongs to another club.')
    }

    const claim = f.claim || null
    const candidates = Array.isArray(claim?.candidates) ? claim.candidates : []
    const isCandidate = candidates.includes(myPilotId)
    // Vol auto-attribué au seul propriétaire : lui seul peut le rendre.
    const isAutoOwner = f.pilotSource === 'owner' && f.pilotId === myPilotId
    if (!isCandidate && !isAutoOwner) throw new HttpsError('permission-denied', 'This flight is not yours to claim.')

    const stamp = FieldValue.serverTimestamp()

    if (mine) {
      if (f.pilotId === myPilotId) return { state: 'already-yours' }
      if (f.pilotId) {                                   // quelqu'un a répondu avant → conflit, pas de vol volé
        const disputedBy = [...new Set([...(claim?.disputedBy || []), myPilotId])]
        tx.set(fRef, { claim: { ...claim, state: 'disputed', disputedBy } }, { merge: true })
        return { state: 'conflict', pilotId: f.pilotId }
      }
      tx.set(fRef, {
        pilotId: myPilotId, pilotRole: 'pilot', flightType: f.flightType || 'solo',
        validated: true, pilotSource: 'claimed', autoAssigned: null,
        claim: { ...(claim || {}), state: 'settled', candidates, settledPilotId: myPilotId, claimedBy: uid, claimedAt: stamp },
      }, { merge: true })
      return { state: 'claimed' }
    }

    if (isAutoOwner) {                                   // « ce n'est pas moi » sur un vol auto-attribué
      tx.set(fRef, {
        pilotId: null, pilotRole: null, flightType: null, validated: false,
        autoAssigned: null, pilotSource: null,
        claim: { state: 'unclaimed', candidates: [], declinedBy: [myPilotId], releasedBy: uid, releasedAt: stamp },
      }, { merge: true })
      return { state: 'released' }
    }

    const declinedBy = [...new Set([...(claim?.declinedBy || []), myPilotId])]
    // Tous ont dit non : le vol n'est plus une affaire de copropriétaires, il rejoint la file d'attribution.
    const all = candidates.every((c) => declinedBy.includes(c))
    tx.set(fRef, { claim: { ...claim, state: all ? 'unclaimed' : 'open', declinedBy } }, { merge: true })
    return { state: all ? 'unclaimed' : 'declined' }
  })

  console.log(`claimFlight ${flightId}: pilot ${myPilotId} (uid ${uid}) mine=${mine} → ${out.state}`)
  return out
})

// Backfill ONE-SHOT de la copropriété (admin) : aligne ownerPilotIds / ownerPilotId sur toutes
// les fiches d'un coup, sans attendre qu'on les ouvre une par une. Idempotent.
exports.backfillOwnerIds = onCall({ region: 'europe-west1' }, async (req) => {
  const uid = req.auth?.uid
  if (!uid) throw new HttpsError('unauthenticated', 'Sign-in required')
  const db = getFirestore()
  const me = (await db.doc(`users/${uid}`).get()).data() || {}
  if (me.role !== 'admin' && me.role !== 'super_admin') throw new HttpsError('permission-denied', 'Admin only')
  const snap = await db.collection('aircraft').get()
  const done = []
  for (const d of snap.docs) {
    const a = d.data()
    if (a.ownership !== 'owner') continue
    const want = ownersOf(a)
    if (!want.length) continue
    const cur = Array.isArray(a.ownerPilotIds) ? a.ownerPilotIds : null
    if (cur && cur.join('|') === want.join('|') && String(a.ownerPilotId || '') === want[0]) continue
    await d.ref.set({ ownerPilotIds: want, ownerPilotId: want[0] }, { merge: true })
    done.push(`${a.callSign || a.registration || d.id}:${want.join('/')}`)
  }
  console.log(`backfillOwnerIds by ${me.email || uid}: ${done.length} fiche(s) — ${done.join(' ') || '∅'}`)
  return { updated: done }
})

// ============================================================
// (v109) reportDevice — le boîtier POST son état firmware/identité en 1 SEUL TLS (pas de token
// Firebase Auth) → tient avec le BLE connecté sur WROVER → /devices se met à jour de façon FIABLE
// SANS kill-BLE ni reboot (avant, le report Firestore REST = 2 TLS échouait heap fragmenté → la
// version ne remontait pas au dashboard sans forcer). MERGE sur les seuls champs du boîtier →
// préserve les champs EMnify (dataUsageMB…). Public + validation boxId ; posture identique aux
// écritures ouvertes existantes (/fdr_status). À durcir (secret partagé) pour un large déploiement.
exports.reportDevice = onRequest({ region: 'europe-west1', cors: true }, async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return }
  const b = req.body || {}
  const boxId = String(b.boxId || '').trim().toUpperCase()
  if (!/^[0-9A-F]{4,8}$/.test(boxId)) { res.status(400).json({ error: 'bad boxId' }); return }
  const db = getFirestore()
  const f = { boxId, lastSeen: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }
  const num = new Set(['fwVersion', 'atvVersion'])
  for (const k of ['clubId', 'callSign', 'icao24', 'board', 'fwVersion', 'fwVersionStr', 'atvVersion', 'otaState', 'wifiSsid', 'iccid', 'wifiKnown']) {   // (2026-09-21) wifiKnown = SSID connus du boîtier (ATC ≥213)
    if (b[k] === undefined || b[k] === null) continue
    f[k] = num.has(k) ? Number(b[k]) : String(b[k])
  }
  try {
    await db.doc(`devices/${boxId}`).set(f, { merge: true })
    res.json({ ok: true, boxId })
  } catch (e) {
    console.error('[reportDevice]', boxId, e)
    res.status(500).json({ error: e.message })
  }
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
  const fleet = []   // { iccid, boxId, callSign, ref }
  devSnap.forEach(d => {
    fleet.push({ iccid: String(d.data().iccid || '').replace(/\D/g, ''), boxId: d.id, callSign: d.data().callSign || '', ref: d.ref })
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
  let matched = 0, renamed = 0, currency = 'EUR'
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

    // Pousse l'identité boîtier → nom de la SIM EMnify : "ATC-<boxId> (<immat>)".
    // Idempotent (PATCH seulement si différent) ; garde le boxId dans le nom (matching futur).
    const desiredName = `ATC-${box.boxId}${box.callSign ? ` (${box.callSign})` : ''}`
    if (ep.name !== desiredName) {
      try {
        const pr = await fetch(`${EMNIFY_BASE}/endpoint/${ep.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ name: desiredName }) })
        if (pr.ok) { renamed++; console.log(`[emnify] rename ${ep.id} "${ep.name}" → "${desiredName}"`) }
        else console.warn(`[emnify] rename ${ep.id} → ${pr.status}`)
      } catch (e) { console.warn('[emnify] rename err', ep.id, e.message) }
    }

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

    // (2026-08-26, suivi conso/heure) HISTORIQUE JOURNALIER : un doc par jour et par boîtier
    // (/devices/{box}/usage/{YYYY-MM-DD}) — idempotent (merge, la synchro 6 h réécrit le même
    // doc). Permet de croiser conso quotidienne × sessions de vol (Mo/h par vol, audit forfait).
    if (daily.lastDayDate) {
      batch.set(box.ref.collection('usage').doc(daily.lastDayDate), {
        mb: daily.lastDayMB, date: daily.lastDayDate,
        monthMB: Math.round(monthMB * 10) / 10,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
    }

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
      emnifyName: desiredName,
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
  const summary = { endpoints: endpoints.length, matched, renamed,
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
