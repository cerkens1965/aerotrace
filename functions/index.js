const { onRequest } = require('firebase-functions/v2/https')
const { onDocumentWritten } = require('firebase-functions/v2/firestore')
const { defineSecret } = require('firebase-functions/params')
const { initializeApp, getApps } = require('firebase-admin/app')
const { getFirestore, FieldValue } = require('firebase-admin/firestore')
const crypto = require('crypto')

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
