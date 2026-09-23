import { useState, useEffect } from 'react'
import { collection, getDocs, query, where, doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { ref as storageRef, getDownloadURL } from 'firebase/storage'
import { httpsCallable } from 'firebase/functions'
import { db, storage, auth, functions } from '../firebase/config'
import { isDurationSuspect } from '../utils/logbookUtils'
import { matches } from '../utils/search'
import { useClub } from '../contexts/ClubContext'
import {
  T, labelStyle, headingStyle, monoStyle,
  Button, MetricCard, StatusDot, DataTable, Drawer, EmptyState, Banner, Chip, Field, Input, Toggle, Skeleton, SearchBox,
} from '../components/ui'

// ─── FleetPage — état firmware de la flotte de boîtiers (ATC) + écrans (ATV) ────
// Vue read-only (admin + super_admin). Lit /devices/{boxId} (écrit par le boîtier
// pendant ses sessions WiFi : upload post-vol + fin d'OTA) et compare la version
// courante à la DERNIÈRE version PUBLIÉE sur Firebase Storage (firmware/<tag>/version.txt)
// → badge « à jour » / « en retard ». La version firmware ne changeant qu'à l'update
// (sur WiFi, où elle est justement enregistrée), la valeur affichée est fiable.
//
// Schéma /devices/{boxId} attendu (écrit par le firmware) :
//   { boxId, clubId, callSign, icao24, board:'s3'|'wrover', fwVersion:int, fwVersionStr,
//     atvVersion:int, atvTag:'ws241'|'t4s3'|'trgb'|'ws216', otaState, wifiSsid,
//     lastSeen:Timestamp, updatedAt:Timestamp }
//
// (2026-09-21, lot 02 B) Restylé AirKi : tokens T, MetricCard, DataTable, Drawer, Banner.
// Statuts : vert = confirmé, ambre = transitoire, gris = éteint — jamais de rouge.

const ATC_TAGS = ['s3', 'wrover', 's3dev']
const ATV_TAGS = ['ws241', 't4s3', 'trgb', 'ws216', 'ws241dev']
// (T30) tag écran déduit du board boîtier quand dev.atvTag est absent : boîtier de banc (s3dev)
// → écran de banc (ws241dev) ; sinon ws241 (flotte WS-241).
const atvTagForBoard = (board) => board === 's3dev' ? 'ws241dev' : 'ws241'

// État OTA → ton de StatusDot (échec = ambre : erreur récupérable, jamais rouge).
const OTA_LABEL = {
  idle: { t: 'idle', tone: 'off' }, available: { t: 'update available', tone: 'caution' },
  downloading: { t: 'downloading…', tone: 'info' }, ok: { t: 'up to date', tone: 'ok' },
  failed: { t: 'failed', tone: 'caution' },
}

const DAY_MS = 24 * 3600 * 1000

function tsMillis(v) {
  if (!v) return 0
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  return v.toMillis?.() ?? 0
}
function seenWithinDay(v) { const ms = tsMillis(v); return !!ms && Date.now() - ms < DAY_MS }
function fmtMB(mb) {
  if (mb == null) return '—'
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`
}
// (23/09, décision Christophe) TARIF DE LA DATA : 8 centimes par MB. EMnify ne renvoyait pas
// de coût (tous les « € » étaient à 0,00) et n'en donne de toute façon qu'au MOIS. En partant
// du volume, le coût devient calculable sur N'IMPORTE QUELLE période — jour, mois, année — et
// pour n'importe quelle sélection de boîtiers. Un seul chiffre à changer le jour où le tarif
// change ; le coût EMnify, s'il finit par arriver, reste lisible dans /fleetMeta.
const EUR_PER_MB = 0.08
const costOf = (mb) => (mb == null ? null : mb * EUR_PER_MB)

// (23/09, demande Christophe) TOTAUX DE CONSOMMATION SUR LA SÉLECTION COURANTE — jour, mois,
// année. Les cartes du haut donnent le total FLOTTE ; ici on somme les lignes RÉELLEMENT
// affichées (recherche et filtres compris), pour répondre à « combien consomment ces
// boîtiers-là ». Les trois périodes viennent telles quelles d'EMnify, par carte SIM
// (lastDayMB / dataUsageMB / yearMB) : rien n'est recalculé ni extrapolé ici.
// Le coût n'existe qu'au MOIS côté EMnify — on ne l'affiche donc pas au jour ni à l'année,
// plutôt que d'inventer une répartition.
function UsageTotals({ rows, total, meta }) {
  const sum = (k) => rows.reduce((a, d) => a + (Number(d[k]) || 0), 0)
  const day = sum('lastDayMB'), month = sum('dataUsageMB'), year = sum('yearMB')
  const cur = meta?.currency || 'EUR'
  const eur = (mb) => `${costOf(mb).toFixed(2)} ${cur}`
  const dayLbl = meta?.lastDayDate ? `DAY · ${meta.lastDayDate.slice(8)}/${meta.lastDayDate.slice(5, 7)}` : 'DAY'
  const items = [
    { l: dayLbl, v: fmtMB(day), sub: eur(day) },
    { l: `MONTH · ${(monthLabel(meta?.monthKey).split(' ')[0] || '').slice(0, 3).toUpperCase()}`, v: fmtMB(month), sub: eur(month) },
    { l: `YEAR · ${meta?.year || ''}`.trim(), v: fmtMB(year), sub: eur(year) },
  ]
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 28, flexWrap: 'wrap',
      padding: '12px 16px', border: T.border, borderTop: 'none', background: T.card }}>
      <span style={{ ...labelStyle(T.etch), minWidth: 130 }}>
        TOTAL · {rows.length} OF {total} UNITS
      </span>
      {items.map(it => (
        <div key={it.l}>
          <div style={labelStyle(T.etch)}>{it.l}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 3 }}>
            <span style={{ ...monoStyle(18, T.ink), fontWeight: 500 }}>{it.v}</span>
            {it.sub && <span style={{ ...monoStyle(12, T.graphite) }}>{it.sub}</span>}
          </div>
        </div>
      ))}
    </div>
  )
}

// fmtMB découpé en [valeur, unité] pour MetricCard.
function mbParts(mb) {
  if (mb == null) return [null, null]
  return mb >= 1024 ? [(mb / 1024).toFixed(2), 'GB'] : [String(Math.round(mb)), 'MB']
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
function monthLabel(key) {   // "2026-07" → "July 2026"
  if (!key || !/^\d{4}-\d{2}$/.test(key)) return 'Current month'
  const [y, m] = key.split('-')
  return `${MONTHS[+m - 1]} ${y}`
}
function fmtSeen(v) {
  const ms = tsMillis(v); if (!ms) return '—'
  const diff = Date.now() - ms
  if (diff < 0) return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z'
  const m = Math.floor(diff / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24)
  if (d > 0) return `${d}d ago`
  if (h > 0) return `${h}h ago`
  if (m > 0) return `${m}min ago`
  return 'just now'
}

// Calculs de versions par boîtier (inchangés, regroupés pour la table ET les métriques).
function unitInfo(dev, published) {
  // OTA : quand rien n'est en cours (idle) ET l'ATC est à jour → « up to date » (vert)
  // au lieu du « idle » peu parlant. Sinon on garde l'état OTA live (available/downloading…).
  const atcLatest = published[dev.board]
  const atcUpToDate = typeof atcLatest === 'number' && dev.fwVersion >= atcLatest
  const otaState = dev.otaState || 'idle'
  const ota = (otaState === 'idle' && atcUpToDate)
    ? { t: 'up to date', tone: 'ok' }
    : (OTA_LABEL[otaState] || OTA_LABEL.idle)
  // Version ATV publiée : par tag écran si connu, sinon la + haute des tags ATV
  // publiés (tous les écrans partagent le même train VIEW_VERSION) → plus de « ? ».
  const atvNums = ATV_TAGS.map(t => published[`atv_${t}`]).filter(v => typeof v === 'number')
  const atvLatest = published[`atv_${dev.atvTag || atvTagForBoard(dev.board)}`] ?? (atvNums.length ? Math.max(...atvNums) : undefined)
  // Chaîne ATV complète « comme l'ATC » : le train MAJOR.MINOR est PARTAGÉ ATC↔ATV
  // (versioning AeroTrace) → préfixe train + suffixe canal de l'ATC, build ATV substitué.
  // Ex ATC "1.2.105-dev" + atv 191 → "1.2.191-dev". (dev.atvVersionStr prévaut si un jour remonté.)
  // \w+ (et non \d+) : le train BANC est « X.1 » (ATC v141).
  const atvVerStr = dev.atvVersionStr
    || (dev.fwVersionStr && dev.atvVersion
        ? dev.fwVersionStr.replace(/^(\w+\.\w+\.)\d+/, `$1${dev.atvVersion}`)
        : (dev.atvVersion ? `v${dev.atvVersion}` : null))
  const atvUpToDate = dev.atvVersion == null || typeof atvLatest !== 'number' || dev.atvVersion >= atvLatest
  return { atcLatest, atcUpToDate, ota, atvLatest, atvVerStr, upToDate: atcUpToDate && atvUpToDate }
}

export default function FleetPage() {
  const { clubId } = useClub()
  const [devices, setDevices] = useState([])
  const [aircraft, setAircraft] = useState([])
  const [published, setPublished] = useState({})   // tag -> int (dernière version publiée)
  const [loading, setLoading] = useState(true)
  const [cfgEdit, setCfgEdit] = useState(null)     // (P1) config-pull : {boxId, reg, type, hex, reported:{...}} ou null
  const [cfgSaving, setCfgSaving] = useState(false)
  const [cfgError, setCfgError] = useState(null)   // erreur d'enregistrement (Banner dans le tiroir, ex-alert)
  const [emnify, setEmnify] = useState(null)       // (P3) /fleetMeta/emnify : { totalUsedMB, poolTotalMB, updatedAt… }
  const [emnifyError, setEmnifyError] = useState(null)
  const [hoursByBox, setHoursByBox] = useState({})  // (2026-08-26) heures de vol du mois par boxId (docs /flights uploadés)
  const [refreshing, setRefreshing] = useState(false)
  const [showOnly, setShowOnly] = useState(null)    // (22/09) filtre tableau : null (tous) | 'attention' | clé de problème (silent/failed/unlinked/data/update)
  const [q, setQ] = useState('')                    // (22/09) recherche : boîtier, avion, version, canal, WiFi
  const [showPw, setShowPw] = useState(false)       // (22/09) tiroir : afficher le mot de passe WiFi
  const [now, setNow] = useState(() => Date.now())  // horloge de page (30 s) : âges « n MIN AGO », boîtiers muets
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t) }, [])

  // Heures de vol du MOIS COURANT par boîtier — pour la colonne MB/h (conso ÷ heures).
  // Requête single-field (endTs epoch ms ≥ début de mois) → pas d'index composite ; somme
  // des durations (secondes) groupée par boxId côté client. Ne compte évidemment que les
  // vols UPLOADÉS (cloud ON) — sans vols, la colonne affiche « — ».
  useEffect(() => {
    const now = new Date()
    const monthStartMs = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    getDocs(query(collection(db, 'flights'), where('endTs', '>=', monthStartMs)))
      .then(snap => {
        const h = {}
        snap.forEach(d => {
          const f = d.data()
          if (!f.boxId || !f.duration || isDurationSuspect(f)) return   // (22/09) durée invraisemblable exclue
          h[f.boxId] = (h[f.boxId] || 0) + Number(f.duration) / 3600
        })
        setHoursByBox(h)
      })
      .catch(err => console.warn('[Fleet] flight hours:', err.message))
  }, [])

  useEffect(() => {
    if (!clubId) { setLoading(false); return }
    setLoading(true)
    // (2026-07-28, demande Christophe) PAS DE FILTRE : on affiche TOUS les boîtiers
    // remontés dans /devices, même ceux à immat placeholder (TBD..) ou pas encore
    // rattachés à un avion du club. Le filtrage par club viendra plus tard. Les avions
    // sont quand même chargés pour résoudre le callSign d'affichage (callSignOf).
    Promise.all([
      getDocs(collection(db, 'devices')),
      getDocs(query(collection(db, 'aircraft'), where('clubId', '==', clubId))),
      getDoc(doc(db, 'fleetMeta', 'emnify')).catch(() => null),
    ]).then(([ds, as, em]) => {
      const acList = as.docs.map(d => ({ id: d.id, ...d.data() }))
      const devs = ds.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.callSign || a.boxId || a.id).localeCompare(b.callSign || b.boxId || b.id))
      setDevices(devs)
      setAircraft(acList)
      setEmnify(em && em.exists() ? em.data() : null)
      setLoading(false)
    }).catch(e => { console.error('[Fleet] load', e); setLoading(false) })
  }, [clubId])

  // (P3) Rafraîchit la conso EMnify à la demande (Cloud Function admin) puis recharge.
  const refreshEmnify = async () => {
    setRefreshing(true)
    setEmnifyError(null)
    try {
      const res = await httpsCallable(functions, 'refreshEmnify')()
      const [ds, em] = await Promise.all([
        getDocs(collection(db, 'devices')),
        getDoc(doc(db, 'fleetMeta', 'emnify')).catch(() => null),
      ])
      setDevices(ds.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.callSign || a.boxId || a.id).localeCompare(b.callSign || b.boxId || b.id)))
      setEmnify(em && em.exists() ? em.data() : null)
      console.log('[Fleet] emnify', res.data)
    } catch (e) {
      console.error('[Fleet] refreshEmnify', e)
      setEmnifyError((e.message || e.code || 'failed') +
        (String(e.message || '').includes('EMNIFY_APP_TOKEN') ? ' — set the token: firebase functions:secrets:set EMNIFY_APP_TOKEN' : ''))
    } finally { setRefreshing(false) }
  }

  // Dernières versions publiées (Storage public-read) — pour le badge « à jour ».
  useEffect(() => {
    let alive = true
    const fetchVer = async (path) => {
      try {
        const url = await getDownloadURL(storageRef(storage, `${path}/version.txt`))
        const txt = await (await fetch(url)).text()
        const n = parseInt(txt.trim(), 10)
        return isFinite(n) ? n : null
      } catch { return null }
    }
    ;(async () => {
      const out = {}
      for (const t of ATC_TAGS) out[t] = await fetchVer(`firmware/${t}`)
      for (const t of ATV_TAGS) out[`atv_${t}`] = await fetchVer(`firmware/atv/${t}`)
      if (alive) setPublished(out)
    })()
    return () => { alive = false }
  }, [])

  // (P1 config-pull) Ouvre l'éditeur d'identité : pré-remplit avec la config DÉSIRÉE existante
  // (/deviceConfig/{boxId}) si présente, sinon avec l'état RAPPORTÉ par le boîtier (/devices).
  const openConfig = async (dev) => {
    const boxId = dev.boxId || dev.id
    let cfg = {}
    try { const s = await getDoc(doc(db, 'deviceConfig', boxId)); if (s.exists()) cfg = s.data() } catch (e) { console.error(e) }
    // (2026-08-31, retour Christophe « il n'a rien poussé, ni code ») HEX pré-rempli en cascade :
    // config désirée si non vide → fiche AÉRONEF (aircraft.icao24, saisie FR24) → état rapporté.
    // Avant, cfg.hex='' (doc de juillet) masquait le hex de la fiche → champ vide, double saisie.
    const regForMatch = (cfg.reg ?? dev.callSign ?? '').toUpperCase()
    const acMatch = aircraft.find(a => ((a.callSign || a.registration || '').toUpperCase() === regForMatch))
    setCfgError(null)
    setCfgEdit({
      boxId,
      // (2026-08-31 soir, « on encode à deux endroits, pas bon ») fromSheet : une fiche aéronef
      // existe → l'identité est GÉRÉE PAR LA FICHE (Admin) + sync auto (CF syncAircraftIdentity).
      // Le tiroir la montre en lecture seule ; on n'édite ici que le WiFi club.
      fromSheet: !!acMatch,
      reg:  (acMatch ? (acMatch.callSign || acMatch.registration) : (cfg.reg ?? dev.callSign)) ?? '',
      type: (acMatch ? (acMatch.typeDesig || '') : (cfg.type ?? '')),
      hex:  ((acMatch ? acMatch.icao24 : (cfg.hex || dev.icao24)) || '').toUpperCase(),
      wifiSsid: cfg.wifiSsid ?? '',
      wifiPass: cfg.wifiPass ?? '',
      otaTag: cfg.otaTag ?? '',        // (2026-09-20) canal OTA du boîtier : '' inchangé · 's3' flotte · 's3dev' dev (ATC ≥210)
      forget: [],                      // (2026-09-21) SSID à SUPPRIMER du boîtier (ATC ≥214) — envoyés avec un numéro de séquence
      reported: { reg: dev.callSign || '', hex: dev.icao24 || '', wifiSsid: dev.wifiSsid || '', wifiKnown: dev.wifiKnown || '', board: dev.board || '' },
      hasConfig: !!(cfg.reg || cfg.wifiSsid),
    })
  }
  const saveConfig = async () => {
    if (!cfgEdit) return
    const reg = (cfgEdit.reg || '').trim().toUpperCase()
    const wifiSsid = (cfgEdit.wifiSsid || '').trim()
    const forget = (cfgEdit.forget || []).filter(Boolean)
    if (!reg && !wifiSsid && !forget.length && !cfgEdit.otaTag) return   // (22/09) un simple changement de canal suffit
    const type = (cfgEdit.type || '').trim().toUpperCase()
    const hex  = (cfgEdit.hex  || '').trim().toUpperCase()
    setCfgSaving(true)
    setCfgError(null)
    try {
      const email = auth.currentUser?.email || null
      // (v108) IDENTITÉ dans un doc PUBLIC (reg/type/hex) → le boîtier la lit en 1 TLS SANS auth
      // (pas de kill-BLE/reboot). JAMAIS de WiFi ici (pass sensible). Écrit seulement si reg fourni.
      if (reg) {
        await setDoc(doc(db, 'deviceConfigPublic', cfgEdit.boxId), {
          boxId: cfgEdit.boxId, reg, type, hex, updatedAt: serverTimestamp(), updatedBy: email,
        }, { merge: true })
      }
      // (2026-09-20) Canal OTA par boîtier → doc PUBLIC (le boîtier ≥210 le lit au config-pull, NVS, puis son écran suit).
      if (cfgEdit.otaTag) {
        await setDoc(doc(db, 'deviceConfigPublic', cfgEdit.boxId), {
          boxId: cfgEdit.boxId, otaTag: cfgEdit.otaTag, updatedAt: serverTimestamp(), updatedBy: email,
        }, { merge: true })
      }
      // Doc AUTH complet (WiFi + trace/affichage). Le boîtier lit le WiFi ici (best-effort, auth).
      await setDoc(doc(db, 'deviceConfig', cfgEdit.boxId), {
        boxId: cfgEdit.boxId, reg, type, hex, otaTag: cfgEdit.otaTag || '',
        wifiSsid, wifiPass: cfgEdit.wifiPass || '',
        // (2026-09-21) suppression de réseaux connus : liste + séquence (le boîtier n'applique qu'une séquence plus récente que la dernière traitée)
        ...(forget.length ? { wifiForget: forget.join(','), wifiForgetSeq: Date.now() } : {}),
        updatedAt: serverTimestamp(), updatedBy: email,
      }, { merge: true })
      // Reflète tout de suite l'immat DÉSIRÉE dans la liste (le report /devices peut retarder).
      setDevices(ds => ds.map(d => (d.boxId || d.id) === cfgEdit.boxId ? { ...d, desiredCallSign: reg || d.desiredCallSign } : d))
      setCfgEdit(null)
    } catch (e) {
      console.error('[Fleet] saveConfig', e)
      setCfgError('Save failed: ' + (e.code || e.message || e) +
        (String(e.code || '').includes('permission') ? ' — your account must be admin or super_admin to write the configuration.' : ''))
    }
    finally { setCfgSaving(false) }
  }

  const callSignOf = (dev) => {
    if (dev.callSign) return dev.callSign
    const a = aircraft.find(x => (dev.icao24 && x.icao24?.toUpperCase() === dev.icao24.toUpperCase()))
    return a ? (a.callSign || a.registration) : '—'
  }

  const closeConfig = () => { if (!cfgSaving) setCfgEdit(null) }

  // ─── Métriques d'en-tête (données déjà chargées) ───
  const rows = devices.map(d => ({ ...d, _info: unitInfo(d, published) }))
  const upToDateCount = rows.filter(r => r._info.upToDate).length
  const seen24h = devices.filter(d => seenWithinDay(d.lastSeen || d.updatedAt)).length
  const pool = emnify?.poolTotalMB, monthMB = emnify?.totalUsedMB
  const pct = (pool && monthMB != null) ? Math.min(100, Math.round(monthMB / pool * 100)) : null
  const currency = emnify?.currency || 'EUR'
  const [monthVal, monthUnit] = mbParts(monthMB)
  const syncText = emnify ? `${emnify.matchedCount ?? 0} SIM · synced ${fmtSeen(emnify.updatedAt)}` : 'never synced'


  // ─── (22/09) Fleet d'après Claude Design « Fleet health dashboard » (export AirKi Dashboard-2) ─────────────────
  // Priorité VISIBILITÉ : gros chiffres mono, un statut par boîtier, panneau encre « NEEDS ATTENTION » en tête.
  const MISSING = '−−−'
  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
  const pad2 = (n) => String(n).padStart(2, '0')
  const utc = (ms) => { const d = new Date(ms); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC` }
  const dayUtc = (ms) => { const d = new Date(ms); return `${pad2(d.getUTCDate())} ${MON[d.getUTCMonth()]}` }
  const seenText = (ms) => { if (!ms) return MISSING; return (now - ms < DAY_MS && new Date(ms).getUTCDate() === new Date().getUTCDate()) ? utc(ms) : `${dayUtc(ms)} · ${utc(ms)}` }
  const agoText = (ms) => { if (!ms) return 'NEVER SEEN'; const m = Math.floor((now - ms) / 60000); const h = Math.floor(m / 60), d = Math.floor(h / 24)
    return d > 0 ? `NOT SEEN ${d} D` : h > 0 ? `${h} H AGO` : m > 0 ? `${m} MIN AGO` : 'JUST NOW' }
  const channelOf = (dev) => (dev.board === 's3dev' ? 'DEV' : 'FLEET')
  const regOf = (dev) => { const r = dev.desiredCallSign || callSignOf(dev); return (!r || r === '—' || /^TBD/i.test(r)) ? null : r }
  const acRecOf = (reg) => aircraft.find(a => (a.callSign || a.registration || '').toUpperCase() === (reg || '').toUpperCase()) || null
  const mbhOf = (dev) => { const h = hoursByBox[dev.id] || 0; return (h >= 0.5 && dev.dataUsageMB != null) ? dev.dataUsageMB / h : null }
  const mbhs = devices.map(mbhOf).filter(v => v != null).sort((a, b) => a - b)
  const medianMbh = mbhs.length ? mbhs[Math.floor(mbhs.length / 2)] : null
  const STALE_DAYS = 3

  // Diagnostic par boîtier : un statut principal + les raisons « à traiter ».
  const diag = (dev) => {
    const info = dev._info, seen = tsMillis(dev.lastSeen || dev.updatedAt)
    const days = seen ? (now - seen) / DAY_MS : Infinity
    const reg = regOf(dev), issues = []
    if (days >= STALE_DAYS) issues.push({ key: 'silent', text: seen ? `NOT SEEN ${Math.floor(days)} D` : 'NEVER SEEN', detail: seen ? `Last report ${dayUtc(seen)} · ${utc(seen)}${dev.wifiSsid ? `, on ${dev.wifiSsid}` : ''}.${dev.board === 'wrover' ? ' WROVER board, due to be retired.' : ''}` : 'No report received from this box yet.' })
    if ((dev.otaState || '') === 'failed') issues.push({ key: 'failed', text: 'UPDATE FAILED', detail: `AKcore ${dev.fwVersion ?? MISSING} did not move to ${info.atcLatest ?? MISSING}. It will retry at the next WiFi.` })
    else if (!info.upToDate) {
      const parts = []
      if (!info.atcUpToDate) parts.push(`AKcore ${dev.fwVersion ?? MISSING} → ${info.atcLatest}`)
      if (dev.atvVersion != null && typeof info.atvLatest === 'number' && dev.atvVersion < info.atvLatest) parts.push(`AKview ${dev.atvVersion} → ${info.atvLatest}`)
      issues.push({ key: 'update', routine: true, text: 'UPDATE AVAILABLE', detail: `${parts.join(' and ') || 'Behind its channel'}. Applies at the next WiFi.` })
    }
    if (!reg) issues.push({ key: 'unlinked', text: 'NO AIRCRAFT LINKED', detail: 'Reporting, but its flights cannot be credited to an aircraft.', action: 'Link' })
    const mbh = mbhOf(dev)
    if (mbh != null && medianMbh && mbhs.length >= 3 && mbh > 2 * medianMbh) issues.push({ key: 'data', text: 'HIGH DATA USE', detail: `${mbh.toFixed(1)} MB per flight hour, more than twice the fleet figure (${medianMbh.toFixed(1)}).` })
    const st = days >= STALE_DAYS ? { tone: 'caution', text: seen ? `NOT SEEN ${Math.floor(days)} D` : 'NEVER SEEN' }
      : (dev.otaState === 'failed') ? { tone: 'caution', text: 'UPDATE FAILED' }
      : dev.otaState === 'downloading' ? { tone: 'info', text: 'UPDATING…' }
      : !info.upToDate ? { tone: 'caution', text: 'UPDATE AVAILABLE' }
      : { tone: 'ok', text: 'UP TO DATE' }
    return { issues, st, reg, seen }
  }
  const diagRows = rows.map(d => ({ ...d, _d: diag(d) }))
  // (22/09) « NEEDS ATTENTION » = anomalies seulement. Une mise à jour en attente est l'état NORMAL d'un
  // déploiement (s'applique au prochain WiFi) → hors panneau, comptée dans la carte UP TO DATE et filtrable
  // dans le tableau. Le panneau est AGRÉGÉ par type de problème (tient à 500 boîtiers), pas une carte par boîtier.
  const isAlert = (d) => d._d.issues.some(i => !i.routine)
  const attention = diagRows.filter(isAlert)
  const ISSUE_GROUPS = [
    { key: 'failed', label: 'UPDATE FAILED', hint: 'The update did not install. It retries at the next WiFi; if it keeps failing, the box needs a look.' },
    { key: 'silent', label: `NOT SEEN FOR ${STALE_DAYS} DAYS OR MORE`, hint: 'No report received. Aircraft grounded, or the box has no known WiFi or 4G.' },
    { key: 'unlinked', label: 'NO AIRCRAFT LINKED', hint: 'Reporting, but its flights cannot be credited to an aircraft.' },
    { key: 'data', label: 'HIGH DATA USE', hint: `More than twice the fleet median MB per flight hour${medianMbh ? ` (${medianMbh.toFixed(1)})` : ''}.` },
  ].map(g => ({ ...g, units: diagRows.filter(d => d._d.issues.some(i => i.key === g.key)) })).filter(g => g.units.length)
  const pendingUpdate = diagRows.filter(d => d._d.issues.some(i => i.key === 'update'))
  const CHIP_MAX = 8
  const filterLabel = { attention: 'NEEDS ATTENTION', update: 'UPDATE PENDING', ...Object.fromEntries(ISSUE_GROUPS.map(g => [g.key, g.label])) }
  const filteredRows = !showOnly ? diagRows
    : showOnly === 'attention' ? attention
    : diagRows.filter(d => d._d.issues.some(i => i.key === showOnly))
  // (22/09) recherche texte, combinée au filtre : boîtier, avion, type, versions, canal, WiFi, état, SIM.
  const shownRows = q.trim()
    ? filteredRows.filter(d => matches(q, d.boxId || d.id, d._d.reg, acRecOf(d._d.reg)?.typeDesig, d.board, channelOf(d),
        d.fwVersion, d.atvVersion, d.wifiSsid, d.wifiKnown, d._d.st.text, d.iccid))
    : filteredRows
  const linkedCount = diagRows.filter(d => d._d.reg).length
  const totalHours = Object.values(hoursByBox).reduce((a, b) => a + b, 0)

  const lab = labelStyle(T.etch)
  const col = (gap = 5, align) => ({ display: 'flex', flexDirection: 'column', gap, minWidth: 0, alignItems: align })
  const big = (size, color = T.ink) => ({ ...monoStyle(size, color), fontWeight: 500, letterSpacing: '0.04em', whiteSpace: 'nowrap' })
  const verLine = (tag, cur, latest, none) => {
    const behind = cur != null && typeof latest === 'number' && cur < latest
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={lab}>{tag}</span>
        <span style={big(17, cur != null ? T.ink : T.etch)}>{cur ?? MISSING}</span>
        {behind && <Chip tone="caution" title={`Latest published on its channel: ${latest}`}>→ {latest}</Chip>}
        {cur == null && none && <span style={lab}>{none}</span>}
      </div>
    )
  }
  const columns = [
    { key: 'unit', label: 'UNIT', render: (dev) => (
      <div style={col()}>
        <span style={big(19)}>{dev.boxId || dev.id}</span>
        <span style={lab}>{dev.board === 'wrover' ? 'WROVER · RETIRING' : 'S3'}</span>
      </div>
    ) },
    { key: 'state', label: 'STATE', render: (dev) => (
      <div style={col(6)}>
        <StatusDot tone={dev._d.st.tone} text={dev._d.st.text} size={10} />
        {!dev._d.reg && <span style={lab}>NO AIRCRAFT LINKED</span>}
      </div>
    ) },
    { key: 'aircraft', label: 'AIRCRAFT', render: (dev) => {
      const rec = acRecOf(dev._d.reg)
      const pending = dev.desiredCallSign && dev.desiredCallSign !== callSignOf(dev)
      return (
        <div style={col()} title={pending ? `Pushed: ${dev.desiredCallSign} (applied at the next WiFi)` : undefined}>
          <span style={big(17, dev._d.reg ? T.ink : T.etch)}>{dev._d.reg || MISSING}</span>
          <span style={lab}>{pending ? 'PENDING' : (rec?.typeDesig || rec?.type || (dev._d.reg ? MISSING : 'NONE'))}</span>
        </div>
      )
    } },
    { key: 'fw', label: 'FIRMWARE', render: (dev) => (
      <div style={col(6)}>
        {verLine('AKC', dev.fwVersion, dev._info.atcLatest)}
        {verLine('AKV', dev.atvVersion, dev._info.atvLatest, 'NO AKview')}
      </div>
    ) },
    { key: 'channel', label: 'CHANNEL', render: (dev) => (channelOf(dev) === 'DEV' ? <Chip tone="info">DEV</Chip> : <Chip muted>FLEET</Chip>) },
    { key: 'wifi', label: 'WIFI / KNOWN NETWORKS', render: (dev) => {
      const n = dev.wifiKnown ? dev.wifiKnown.split(',').filter(x => x.trim()).length : 0
      return (
        <div style={col()} title={dev.wifiKnown ? `Known networks: ${dev.wifiKnown}` : undefined}>
          <span style={{ ...monoStyle(14, dev.wifiSsid ? T.ink : T.etch), overflowWrap: 'anywhere' }}>{dev.wifiSsid || MISSING}</span>
          <span style={lab}>{n ? `${n} KNOWN NETWORK${n === 1 ? '' : 'S'}` : 'NO LIST REPORTED'}</span>
        </div>
      )
    } },
    { key: 'data', label: `DATA · ${(monthLabel(emnify?.monthKey).split(' ')[0] || 'MONTH').slice(0, 3).toUpperCase()}`, align: 'right', render: (dev) => {
      const mbh = mbhOf(dev)
      return (
        <div style={col(5, 'flex-end')} title={[dev.iccid ? `ICCID ${dev.iccid}` : 'not linked to a SIM', dev.yearMB != null ? `Year: ${fmtMB(dev.yearMB)}` : '', dev.overallMB != null ? `Overall: ${fmtMB(dev.overallMB)}` : ''].filter(Boolean).join('\n')}>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
            <span style={big(19, dev.dataUsageMB != null ? T.ink : T.etch)}>{dev.dataUsageMB != null ? Math.round(dev.dataUsageMB) : MISSING}</span>
            <span style={lab}>MB</span>
          </span>
          <span style={lab}>{dev.dataUsageMB != null ? `€ ${costOf(dev.dataUsageMB).toFixed(2)}` : '€ −−−'} · {mbh != null ? `${mbh.toFixed(1)} MB/H` : '−−− MB/H'}</span>
        </div>
      )
    } },
    { key: 'seen', label: 'LAST SEEN', align: 'right', render: (dev) => (
      <div style={col(5, 'flex-end')}>
        <span style={{ ...monoStyle(14, dev._d.seen && now - dev._d.seen < STALE_DAYS * DAY_MS ? T.ink : T.etch), whiteSpace: 'nowrap' }}>{seenText(dev._d.seen)}</span>
        <span style={lab}>{agoText(dev._d.seen)}</span>
      </div>
    ) },
  ]

  const knownNetworks = cfgEdit?.reported.wifiKnown
    ? cfgEdit.reported.wifiKnown.split(',').map(x => x.trim()).filter(Boolean)
    : []
  const canPush = !!cfgEdit && !cfgSaving && !!(cfgEdit.reg.trim() || cfgEdit.wifiSsid.trim() || (cfgEdit.forget || []).length || cfgEdit.otaTag)
  const editDev = cfgEdit ? diagRows.find(d => (d.boxId || d.id) === cfgEdit.boxId) : null
  const fact = (label, value, wide) => (
    <div style={{ ...col(4), gridColumn: wide ? '1 / -1' : undefined }}>
      <span style={lab}>{label}</span>
      <span style={wide ? big(22) : monoStyle(14)}>{value || MISSING}</span>
    </div>
  )
  const syncLine = emnify?.updatedAt ? `SIM DATA SYNCED ${dayUtc(tsMillis(emnify.updatedAt))} · ${utc(tsMillis(emnify.updatedAt))}` : 'SIM DATA NEVER SYNCED'
  const pubLine = `PUBLISHED NOW · FLEET CHANNEL AKC ${published.s3 ?? MISSING} / AKV ${published.atv_ws241 ?? MISSING} · DEV CHANNEL AKC ${published.s3dev ?? MISSING} / AKV ${published.atv_ws241dev ?? MISSING}`

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: T.paper, color: T.ink, fontFamily: T.sans }}>
      <main style={{ maxWidth: 1400, padding: '28px 32px 48px', display: 'flex', flexDirection: 'column', gap: 20 }}>
        <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
          <div style={col(6)}>
            <span style={lab}>FIRMWARE · SIM DATA · WIFI</span>
            <h1 style={{ ...headingStyle(28), margin: 0 }}>Fleet</h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={lab}>{syncLine}</span>
            <Button size="sm" variant="ghost" icon="refresh" onClick={refreshEmnify} disabled={refreshing}>{refreshing ? 'Syncing…' : 'Refresh'}</Button>
          </div>
        </header>

        {emnifyError && <Banner tone="caution" title="Data usage refresh failed" onRetry={refreshEmnify}>{emnifyError}</Banner>}

        {!loading && !clubId ? (
          <div style={{ background: T.card, border: T.border, borderRadius: T.radius.md }}><EmptyState text="Select a club first." /></div>
        ) : loading ? (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
              {[0, 1, 2, 3].map(i => <Skeleton key={i} height={108} radius={6} />)}
            </div>
            <Skeleton height={76} radius={6} />
            <DataTable columns={columns.map(c => ({ key: c.key, label: c.label, align: c.align }))} rows={[]} loading />
            <span style={lab}>READING THE LAST REPORT OF EACH AKcore …</span>
          </>
        ) : devices.length === 0 ? (
          <>
            <Banner tone="info" title="Nothing to show until a box reports">An AKcore reports as soon as it powers up and reaches a known WiFi network.</Banner>
            <div style={{ background: T.card, border: T.border, borderRadius: T.radius.md, padding: 8 }}>
              <EmptyState text="No box has reported yet. The fleet board fills itself as each AKcore comes online." />
            </div>
          </>
        ) : (<>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <MetricCard label="UP TO DATE" value={String(upToDateCount)} unit={`OF ${devices.length}`}
              status={upToDateCount === devices.length ? { tone: 'ok', text: 'All units current' } : { tone: 'caution', text: `${devices.length - upToDateCount} unit${devices.length - upToDateCount === 1 ? '' : 's'} behind their channel` }} />
            <MetricCard label="UNITS SEEN" value={String(seen24h)} unit={`OF ${devices.length}`}
              status={seen24h === devices.length ? { tone: 'ok', text: 'All seen in the last 24 h' } : { tone: 'caution', text: `${devices.length - seen24h} silent for more than 24 h` }} />
            <MetricCard label={`DATA · ${monthLabel(emnify?.monthKey).toUpperCase()}`} value={monthVal} unit={monthUnit}
              status={pct != null ? { tone: pct >= 70 ? 'caution' : 'ok', text: `${pct} % of ${fmtMB(pool)} pool` } : { tone: 'off', text: syncText }} />
            <MetricCard label="COST · MONTH" value={monthMB != null ? costOf(monthMB).toFixed(2) : null} unit={currency}
              status={monthMB != null && totalHours >= 1
                ? { tone: 'off', text: `${(costOf(monthMB) / totalHours).toFixed(2)} ${currency} per flight hour · ${EUR_PER_MB.toFixed(2)} ${currency}/MB` }
                : { tone: emnify ? 'ok' : 'off', text: syncText }} />
          </div>

          <section aria-label="Needs attention" style={{ background: T.ink, borderRadius: T.radius.md, padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <span style={labelStyle(T.mutedDark)}>NEEDS ATTENTION</span>
                <span style={{ ...monoStyle(26, T.white), lineHeight: 1 }}>{attention.length}</span>
                <span style={labelStyle(T.mutedDark)}>OF {devices.length} UNITS</span>
              </div>
                {attention.length > 0 && (
                <Button size="sm" onInk icon="filter" onClick={() => setShowOnly(v => v === 'attention' ? null : 'attention')}>
                  {showOnly === 'attention' ? `Show all ${devices.length} units` : `Show only these ${attention.length}`}
                </Button>
              )}
            </div>
            {attention.length === 0 ? (
              <StatusDot tone="ok" onInk text="EVERY UNIT IS SEEN AND LINKED" />
            ) : (
              <div style={col(0)}>
                {ISSUE_GROUPS.map((g, gi) => (
                  <div key={g.key} style={{ borderTop: gi ? `1px solid ${T.ruleDark}` : 'none', padding: '12px 0', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                    <div style={{ ...col(6), flex: '1 1 420px' }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                        <span style={{ ...monoStyle(20, T.white), lineHeight: 1 }}>{g.units.length}</span>
                        <StatusDot tone="caution" onInk text={g.label} />
                      </div>
                      <span style={{ fontSize: 13, lineHeight: 1.45, color: T.mutedDark }}>{g.hint}</span>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {g.units.slice(0, CHIP_MAX).map(dev => (
                          <button key={dev.id} type="button" onClick={() => openConfig(dev)} title={dev._d.issues.filter(i => i.key === g.key).map(i => i.detail).join(' ')}
                            style={{ ...monoStyle(12, T.white), background: 'transparent', border: `1px solid ${T.ruleDark}`, borderRadius: T.radius.sm, padding: '3px 8px', cursor: 'pointer' }}>
                            {dev.boxId || dev.id}{dev._d.reg ? ` · ${dev._d.reg}` : ''}
                          </button>
                        ))}
                        {g.units.length > CHIP_MAX && <span style={{ ...labelStyle(T.mutedDark), alignSelf: 'center' }}>+{g.units.length - CHIP_MAX} MORE</span>}
                      </div>
                    </div>
                    <Button size="sm" onInk icon="filter" onClick={() => setShowOnly(v => v === g.key ? null : g.key)}>
                      {showOnly === g.key ? 'Show all' : `Show these ${g.units.length}`}
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {pendingUpdate.length > 0 && (
              <span style={labelStyle(T.mutedDark)}>{pendingUpdate.length} UNIT{pendingUpdate.length === 1 ? '' : 'S'} WAITING FOR AN UPDATE · APPLIED AT THE NEXT WIFI · NOT AN ISSUE</span>
            )}
          </section>

          <section aria-label="Club fleet" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, paddingBottom: 8, borderBottom: T.border, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
                <h2 style={{ ...headingStyle(15), margin: 0 }}>Club fleet · AKcore</h2>
                <span style={lab}>{showOnly ? `${shownRows.length} OF ${devices.length} UNITS · ${filterLabel[showOnly] || ''}` : `${devices.length} UNITS · ${linkedCount} AIRCRAFT LINKED · ${devices.length - linkedCount} UNASSIGNED`}</span>
              </div>
              <SearchBox value={q} onChange={setQ} width={300} count={shownRows.length} total={devices.length}
                placeholder="Unit, aircraft, version, channel or WiFi · Esc clears" />
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={lab}>SHOW</span>
                <Toggle mono active={!showOnly} onClick={() => setShowOnly(null)}>ALL {devices.length}</Toggle>
                <Toggle mono active={showOnly === 'attention' || ISSUE_GROUPS.some(g => g.key === showOnly)} onClick={() => setShowOnly('attention')}>NEEDS ATTENTION {attention.length}</Toggle>
                <Toggle mono active={showOnly === 'update'} onClick={() => setShowOnly('update')}>UPDATE PENDING {pendingUpdate.length}</Toggle>
              </div>
            </div>
            <DataTable columns={columns} rows={shownRows} rowKey="id" onRowClick={openConfig}
              empty={<EmptyState text="No unit matches this filter." />} />
            <UsageTotals rows={shownRows} total={devices.length} meta={emnify} />
            <span style={lab}>{pubLine}</span>
          </section>
        </>)}
      </main>

      {/* Tiroir boîtier — écrit /deviceConfig(+Public)/{boxId}, le boîtier le tire à sa prochaine session WiFi */}
      <Drawer closeOnOverlay={false} open={!!cfgEdit} onClose={closeConfig}
        title={cfgEdit ? `Unit ${cfgEdit.boxId}` : ''}
        subtitle={editDev ? [editDev._d.reg || 'No aircraft', `AKC ${editDev.fwVersion ?? MISSING} / AKV ${editDev.atvVersion ?? MISSING}`, `${channelOf(editDev)} channel`, agoText(editDev._d.seen).toLowerCase()].join(' · ') : ''}
        footer={cfgEdit && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
            <span style={lab}>APPLIED AT THE NEXT WIFI</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" variant="ghost" onClick={closeConfig} disabled={cfgSaving}>Cancel</Button>
              <Button size="sm" variant="primary" icon="check" onClick={saveConfig} disabled={!canPush}>{cfgSaving ? 'Pushing…' : 'Save & push to box'}</Button>
            </div>
          </div>
        )}>
        {cfgEdit && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {cfgError && <Banner tone="caution" title="Not pushed">{cfgError}</Banner>}

            {cfgEdit.fromSheet ? (
              <div style={{ border: T.border, borderRadius: T.radius.md, background: '#FBFAF7', padding: 14, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                <div style={{ ...col(4), gridColumn: '1 / -1' }}>
                  <span style={lab}>IDENTITY · FROM THE AIRCRAFT RECORD</span>
                  <span style={big(22)}>{cfgEdit.reg}</span>
                </div>
                {fact('ICAO TYPE', cfgEdit.type)}
                {fact('ICAO HEX', cfgEdit.hex)}
                {fact('BOARD', (cfgEdit.reported.board || '').toUpperCase())}
                {fact('AKview PAIRED', editDev?.atvVersion != null ? `AKV ${editDev.atvVersion}` : 'NONE')}
                <span style={{ gridColumn: '1 / -1', fontSize: 12, lineHeight: 1.4, color: T.graphite }}>Edit the identity in Admin → Aircraft; it is synced to the box automatically.</span>
              </div>
            ) : (
              <div style={col(12)}>
                <span style={{ ...lab, color: T.ink }}>IDENTITY</span>
                <Field label="REGISTRATION / CALLSIGN *" hint="No aircraft record: direct entry.">
                  <Input mono value={cfgEdit.reg} placeholder="OOI43" onChange={v => setCfgEdit(c => ({ ...c, reg: v }))} />
                </Field>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <Field label="ICAO TYPE" style={{ flex: '1 1 140px' }}><Input mono value={cfgEdit.type} placeholder="FK9 / VL3…" onChange={v => setCfgEdit(c => ({ ...c, type: v }))} /></Field>
                  <Field label="HEX (IF TRANSPONDER)" style={{ flex: '1 1 140px' }}><Input mono value={cfgEdit.hex} placeholder="empty if no ADS-B" onChange={v => setCfgEdit(c => ({ ...c, hex: v }))} /></Field>
                </div>
                <span style={{ fontSize: 12, color: T.graphite }}>On the box now: <span style={monoStyle(12)}>{cfgEdit.reported.reg || MISSING}{cfgEdit.reported.hex ? ` / ${cfgEdit.reported.hex}` : ''}</span></span>
              </div>
            )}
            {cfgEdit.hasConfig && <StatusDot tone="caution" text="A CONFIGURATION IS ALREADY PENDING" />}

            <Field label="UPDATE CHANNEL" hint={`Dev boxes receive a new version before the rest of the fleet; the AKview follows.${cfgEdit.reported.board ? ` Currently ${channelOf({ board: cfgEdit.reported.board }).toLowerCase()}.` : ''}`}>
              <div style={{ display: 'flex', gap: 6 }}>
                <Toggle active={!cfgEdit.otaTag} onClick={() => setCfgEdit(c => ({ ...c, otaTag: '' }))}>Unchanged</Toggle>
                <Toggle active={cfgEdit.otaTag === 's3'} onClick={() => setCfgEdit(c => ({ ...c, otaTag: 's3' }))}>Fleet</Toggle>
                <Toggle active={cfgEdit.otaTag === 's3dev'} onClick={() => setCfgEdit(c => ({ ...c, otaTag: 's3dev' }))}>Dev</Toggle>
              </div>
            </Field>

            <div id="fleet-club-wifi" style={{ borderTop: '1px solid #EDE9E2', paddingTop: 16, ...col(12) }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ ...lab, color: T.ink }}>CLUB WIFI</span>
                {cfgEdit.reported.wifiSsid && <Chip tone="ok">CONNECTED · {cfgEdit.reported.wifiSsid}</Chip>}
              </div>
              <Field label="SSID" hint="Optional. Becomes the box's first network.">
                <Input mono id="fleet-ssid" value={cfgEdit.wifiSsid} placeholder="EBBY" onChange={v => setCfgEdit(c => ({ ...c, wifiSsid: v }))} />
              </Field>
              <Field label="PASSWORD" hint="Visible to designated dashboard members only.">
                <div style={{ display: 'flex', gap: 6 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <Input mono type={showPw ? 'text' : 'password'} autoComplete="new-password" value={cfgEdit.wifiPass}
                      placeholder={cfgEdit.wifiSsid ? '••••••••' : ''} onChange={v => setCfgEdit(c => ({ ...c, wifiPass: v }))} />
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setShowPw(v => !v)}>{showPw ? 'Hide' : 'Show'}</Button>
                </div>
              </Field>
            </div>

            <div style={{ borderTop: '1px solid #EDE9E2', paddingTop: 16, ...col(10) }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span style={{ ...lab, color: T.ink }}>KNOWN WIFI NETWORKS</span>
                <span style={lab}>{knownNetworks.length} OF 6</span>
              </div>
              {knownNetworks.length === 0 && <span style={{ fontSize: 13, color: T.graphite }}>The box has not reported its list yet (AKcore 213 or later).</span>}
              {knownNetworks.map((x, i) => {
                const onBox = x.endsWith('*'); const name = onBox ? x.slice(0, -1) : x
                const active = name.toLowerCase() === (cfgEdit.reported.wifiSsid || '').toLowerCase()
                const marked = (cfgEdit.forget || []).includes(name)
                return (
                  <div key={i} style={{ border: T.border, borderRadius: T.radius.md, padding: '10px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, opacity: marked ? 0.6 : 1 }}>
                    <div style={col(4)}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={lab}>{i + 1}</span>
                        <span style={{ ...monoStyle(14), overflowWrap: 'anywhere' }}>{name}</span>
                      </div>
                      <span style={lab}>{[active ? 'CONNECTED' : null, onBox ? 'ADDED ON THE BOX · PROTECTED' : 'ADDED FROM THE DASHBOARD', marked ? 'REMOVAL PENDING' : null].filter(Boolean).join(' · ')}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Button size="sm" variant="ghost" icon="edit" title="Change this network's password" aria-label="Edit network"
                        onClick={() => { setCfgEdit(c => ({ ...c, wifiSsid: name, wifiPass: '' })); document.getElementById('fleet-ssid')?.focus() }} style={{ width: 32, padding: 0, justifyContent: 'center' }} />
                      <Button size="sm" variant={marked ? 'secondary' : 'ghost'}
                        onClick={() => setCfgEdit(c => ({ ...c, forget: marked ? c.forget.filter(y => y !== name) : [...(c.forget || []), name] }))}>
                        {marked ? 'Keep' : 'Forget'}
                      </Button>
                    </div>
                  </div>
                )
              })}
              <Button size="sm" icon="wifi" onClick={() => { setCfgEdit(c => ({ ...c, wifiSsid: '', wifiPass: '' })); document.getElementById('fleet-ssid')?.focus() }}>Add a network</Button>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: T.graphite }}>
                Order is the box's priority. Changes are applied the next time the box reaches WiFi (forget needs AKcore 214 or later). A network added on the box appears here after its next report.
              </p>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
