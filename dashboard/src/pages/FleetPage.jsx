import { useState, useEffect } from 'react'
import { collection, getDocs, query, where, doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { ref as storageRef, getDownloadURL } from 'firebase/storage'
import { httpsCallable } from 'firebase/functions'
import { db, storage, auth, functions } from '../firebase/config'
import { useClub } from '../contexts/ClubContext'
import {
  T, labelStyle, headingStyle, monoStyle,
  Button, MetricCard, StatusDot, DataTable, Tabs, Drawer, EmptyState, Banner,
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

// Puce mono bordée (bandeau VERSIONS, badges de version).
function Chip({ children, title, tone, muted }) {
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, height: 22, padding: '0 8px',
      border: T.border, borderRadius: T.radius.sm, background: T.card, whiteSpace: 'nowrap',
      ...monoStyle(11, muted ? T.etch : T.ink), fontWeight: 500,
    }}>
      {tone && <StatusDot tone={tone} size={6} />}
      {children}
    </span>
  )
}

// Badge version : point vert si à jour, puce « → vN » (point ambre) si en retard,
// version seule si la version publiée est inconnue.
function VerBadge({ cur, curStr, latest, fleetMax }) {
  if (cur == null) return <span style={monoStyle(12, T.etch)}>—</span>
  const known = typeof latest === 'number'
  const upToDate = known && cur >= latest
  // (2026-08-03) « périmé vs PARC » : à jour sur son tag OTA mais un build PLUS RÉCENT roule déjà
  // sur un autre appareil (flash USB dev, pas encore béni/publié) → puce grise discrète.
  const behindFleet = typeof fleetMax === 'number' && fleetMax > cur && (!known || cur >= latest)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      <span style={{ ...monoStyle(12), fontWeight: 500 }}>{curStr || `v${cur}`}</span>
      {known && (upToDate
        ? <span title={`Up to date (v${latest} published)`}><StatusDot tone="ok" /></span>
        : <Chip tone="caution" title={`Update available: v${latest}`}>→ v{latest}</Chip>)}
      {behindFleet && (
        <Chip muted title={`A newer build is running in the fleet: v${fleetMax} (dev, not published on the OTA tag)`}>← v{fleetMax} dev</Chip>
      )}
    </span>
  )
}

// Libellé de champ + contrôle (top-level : pas de remontage à chaque rendu).
function Field({ label, hint, children, style }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, ...style }}>
      <span style={labelStyle(T.etch)}>{label}</span>
      {children}
      {hint && <span style={{ fontSize: 12, lineHeight: 1.4, color: T.graphite }}>{hint}</span>}
    </label>
  )
}

// Section du tiroir : titre Semibold 13 + filet haut.
function Section({ title, first, children }) {
  return (
    <section style={{ paddingTop: first ? 0 : 16, marginTop: first ? 0 : 16, borderTop: first ? 'none' : T.border, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <h3 style={{ ...headingStyle(14), margin: 0 }}>{title}</h3>
      {children}
    </section>
  )
}

const inputStyle = {
  height: 34, padding: '0 10px', border: T.border, borderRadius: T.radius.sm, background: T.card,
  ...monoStyle(13), width: '100%', boxSizing: 'border-box',
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
          if (!f.boxId || !f.duration) return
          h[f.boxId] = (h[f.boxId] || 0) + Number(f.duration) / 3600
        })
        setHoursByBox(h)
      })
      .catch(err => console.warn('[Fleet] flight hours:', err.message))
  }, [])
  // (2026-08-03) version max VUE dans le parc (FW_VERSION/VIEW_VERSION monotones toutes cartes)
  const fleetMaxFw  = devices.reduce((m, d) => Math.max(m, d.fwVersion  || 0), 0)
  const fleetMaxAtv = devices.reduce((m, d) => Math.max(m, d.atvVersion || 0), 0)

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
    if (!reg && !wifiSsid && !forget.length) return
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

  const latestAtcPub = Math.max(...ATC_TAGS.map(t => published[t] ?? 0))
  const latestAtvPub = published['atv_ws241'] ?? 0

  // ─── Colonnes du tableau ───
  const sub = { ...monoStyle(11, T.graphite), marginTop: 2 }
  const columns = [
    {
      key: 'unit', label: 'UNIT', mono: true,
      render: (dev) => <span style={{ fontWeight: 500 }}>{dev.boxId || dev.id}</span>,
    },
    {
      key: 'aircraft', label: 'AIRCRAFT', mono: true,
      render: (dev) => {
        const reported = callSignOf(dev)
        const pending = dev.desiredCallSign && dev.desiredCallSign !== reported
        return (
          <div title={pending ? `Pushed: ${dev.desiredCallSign} (the unit applies it at its next WiFi session)` : 'Open unit configuration'}>
            <div style={{ fontWeight: 500 }}>{pending ? dev.desiredCallSign : reported}</div>
            {pending && <StatusDot tone="caution" text={`pending · was ${reported}`} style={{ marginTop: 4 }} />}
          </div>
        )
      },
    },
    {
      key: 'core', label: 'CORE FW',
      render: (dev) => (
        <VerBadge cur={dev.fwVersion} curStr={dev.fwVersionStr} latest={dev._info.atcLatest} fleetMax={fleetMaxFw} />
      ),
    },
    {
      key: 'view', label: 'VIEW FW',
      render: (dev) => (
        <VerBadge cur={dev.atvVersion} curStr={dev._info.atvVerStr} latest={dev._info.atvLatest} fleetMax={fleetMaxAtv} />
      ),
    },
    {
      key: 'channel', label: 'CHANNEL',
      render: (dev) => (
        <div>
          <div style={monoStyle(12)}>{dev.board || '?'}</div>
          <StatusDot tone={dev._info.ota.tone} text={dev._info.ota.t} style={{ marginTop: 4 }} />
        </div>
      ),
    },
    {
      key: 'wifi', label: 'WIFI / KNOWN NETWORKS',
      render: (dev) => (
        <div style={{ minWidth: 120 }}>
          <div style={monoStyle(12, dev.wifiSsid ? T.ink : T.etch)}>{dev.wifiSsid || '—'}</div>
          {/* (2026-09-21) réseaux WiFi connus du boîtier (ATC ≥213) : « ssid* » = saisi par le pilote (protégé), sans étoile = poussé par le dashboard */}
          {dev.wifiKnown && (
            <div style={sub} title="WiFi networks known to the unit — * = entered by the pilot (protected)">
              {dev.wifiKnown}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'data', label: 'DATA/MONTH', align: 'right', mono: true,
      render: (dev) => (
        <div title={[
          dev.iccid ? `ICCID ${dev.iccid}` : (dev.emnifyName ? `EMnify: ${dev.emnifyName}` : 'not linked to a SIM'),
          dev.simStatus ? `SIM ${dev.simStatus}` : '',
          dev.yearMB != null ? `Year: ${fmtMB(dev.yearMB)}` : '',
          dev.overallMB != null ? `Overall: ${fmtMB(dev.overallMB)}` : '',
          dev.lastDayMB != null ? `Last day (${dev.lastDayDate || '?'}): ${fmtMB(dev.lastDayMB)}` : '',
        ].filter(Boolean).join('\n')}>
          <div style={{ color: dev.dataUsageMB != null ? T.ink : T.etch }}>
            {dev.dataUsageMB != null ? fmtMB(dev.dataUsageMB) : (dev.iccid || dev.emnifyName ? '—' : '·')}
          </div>
          {dev.overallMB != null && <div style={sub}>Σ {fmtMB(dev.overallMB)}</div>}
        </div>
      ),
    },
    {
      key: 'cost', label: 'COST', align: 'right', mono: true,
      render: (dev) => (
        <span style={{ color: dev.dataCost ? T.ink : T.etch, whiteSpace: 'nowrap' }}>
          {dev.dataCost != null ? `${dev.dataCost.toFixed(2)} ${dev.dataCostCur || 'EUR'}` : '—'}
        </span>
      ),
    },
    {
      key: 'mbh', label: 'MB/H', align: 'right', mono: true,
      render: (dev) => {   // (2026-08-26) MB/h = conso mois ÷ heures de vol uploadées du mois
        const h = hoursByBox[dev.id] || 0
        const ok = h >= 0.5 && dev.dataUsageMB != null   // <30 min de vol = ratio non significatif
        return (
          <span title={h > 0 ? `${h.toFixed(1)} h of flight uploaded this month` : 'no flight uploaded this month (cloud off?)'}
                style={{ color: ok ? T.ink : T.etch }}>
            {ok ? `${(dev.dataUsageMB / h).toFixed(1)}` : '—'}
          </span>
        )
      },
    },
    {
      key: 'seen', label: 'LAST SEEN', align: 'right', mono: true,
      render: (dev) => <span style={{ color: T.graphite, whiteSpace: 'nowrap' }}>{fmtSeen(dev.lastSeen || dev.updatedAt)}</span>,
    },
  ]

  const knownNetworks = cfgEdit?.reported.wifiKnown
    ? cfgEdit.reported.wifiKnown.split(',').map(x => x.trim()).filter(Boolean)
    : []
  const canPush = !!cfgEdit && !cfgSaving && !!(cfgEdit.reg.trim() || cfgEdit.wifiSsid.trim() || (cfgEdit.forget || []).length)

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: T.paper, color: T.ink, fontFamily: T.sans }}>
      <div style={{ maxWidth: 1240, margin: '0 auto', padding: '24px 24px 40px' }}>
        {/* En-tête */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ ...headingStyle(24), margin: 0 }}>Fleet</h1>
          <span style={labelStyle(T.etch)}>FIRMWARE · ADMIN</span>
        </div>
        <p style={{ fontSize: 14, lineHeight: 1.5, color: T.graphite, margin: '6px 0 0', maxWidth: 720 }}>
          Firmware status of each AirKi Core unit (AKT) and its AirKi View display (AKV). Updated whenever
          the unit reaches WiFi (post-flight upload or end of an update).
        </p>

        {/* Métriques clés */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginTop: 18 }}>
          <MetricCard
            label="UP TO DATE"
            value={loading || !clubId ? null : `${upToDateCount}/${devices.length}`}
            status={devices.length ? (upToDateCount === devices.length
              ? { tone: 'ok', text: 'all units current' }
              : { tone: 'caution', text: `${devices.length - upToDateCount} behind` }) : undefined}
          />
          <MetricCard
            label="UNITS SEEN"
            value={loading || !clubId ? null : devices.length}
            status={devices.length ? { tone: seen24h ? 'ok' : 'off', text: `${seen24h} in last 24 h` } : undefined}
          />
          <MetricCard
            label={`DATA · ${monthLabel(emnify?.monthKey).toUpperCase()}`}
            value={monthVal}
            unit={monthUnit}
            status={pct != null
              ? { tone: pct >= 70 ? 'caution' : 'ok', text: `${pct}% of ${fmtMB(pool)} pool` }
              : { tone: 'off', text: syncText }}
          />
          <MetricCard
            label="COST · MONTH"
            value={emnify?.totalCost != null ? emnify.totalCost.toFixed(2) : null}
            unit={currency}
            status={{ tone: emnify ? 'ok' : 'off', text: syncText }}
          />
        </div>

        {/* Conso EMnify — lue en direct depuis EMnify (rien cumulé chez nous) */}
        <div style={{ marginTop: 12, padding: '10px 14px', background: T.card, border: T.border, borderRadius: T.radius.md, display: 'flex', alignItems: 'center', gap: 18, rowGap: 8, flexWrap: 'wrap' }}>
          <span style={labelStyle(T.etch)}>DATA · EMNIFY</span>
          {[['OVERALL', emnify?.overallMB, 'since activation'],
            [String(emnify?.year || '2026'), emnify?.yearMB, 'current year'],
            ['LAST DAY', emnify?.lastDayMB, emnify?.lastDayDate || '']].map(([l, mb, t]) => (
            <span key={l} title={t} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
              <span style={labelStyle(T.etch)}>{l}</span>
              <span style={{ ...monoStyle(13), fontWeight: 500 }}>{fmtMB(mb)}</span>
            </span>
          ))}
          <Button size="sm" icon="refresh" onClick={refreshEmnify} disabled={refreshing} style={{ marginLeft: 'auto' }}>
            {refreshing ? 'Syncing…' : 'Refresh data usage'}
          </Button>
        </div>
        {emnifyError && (
          <Banner tone="caution" title="Data usage refresh failed" style={{ marginTop: 12 }} onRetry={refreshEmnify}>
            {emnifyError}
          </Banner>
        )}

        {/* (2026-08-31, demande Christophe, v2) La DERNIÈRE version (build le plus récent VU dans le parc,
            banc compris) s'affiche EN PREMIER — c'est elle qu'on cherche. La version PUBLIÉE par tag OTA
            (celle que la flotte télécharge) vient ensuite. Si dernière > publiée → puce « unpublished ». */}
        <div style={{ marginTop: 12, padding: '10px 14px', background: T.card, border: T.border, borderRadius: T.radius.md, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 18, rowGap: 10 }}>
          <span style={labelStyle(T.etch)}>VERSIONS</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ ...labelStyle(T.graphite), marginRight: 2 }}>LATEST IN FLEET</span>
            {[['Core', fleetMaxFw, latestAtcPub], ['View', fleetMaxAtv, latestAtvPub]].map(([fam, last, pub]) => (
              <span key={fam} style={{ display: 'inline-flex', gap: 6 }}>
                <Chip title="Most recent build seen in the fleet (bench included)">{fam} v{last || '?'}</Chip>
                {last > pub && (
                  <Chip tone="caution" title="Not yet published on the OTA tags — the fleet does not download it (bench/dev build)">unpublished</Chip>
                )}
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span title="version.txt of the OTA tags on Firebase Storage — this is what units and displays download"
                  style={{ ...labelStyle(T.graphite), marginRight: 2 }}>PUBLISHED · OTA</span>
            {ATC_TAGS.map(t => <Chip key={t}>{t} v{published[t] ?? '?'}</Chip>)}
            <Chip>ws241 v{published['atv_ws241'] ?? '?'}</Chip>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <StatusDot tone="ok" text="up to date" />
            <StatusDot tone="caution" text="→ vN update available" />
            <StatusDot tone="off" text="← vN dev: newer bench build" />
          </div>
        </div>

        {/* Tableau des boîtiers */}
        <div style={{ marginTop: 16 }}>
          {!loading && !clubId ? (
            <div style={{ background: T.card, border: T.border, borderRadius: T.radius.md }}>
              <EmptyState text="Select a club first." />
            </div>
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              rowKey="id"
              loading={loading}
              onRowClick={openConfig}
              empty={<EmptyState text="No unit has reported its status yet. A unit appears here after its first WiFi session (post-flight upload or update)." />}
            />
          )}
        </div>
      </div>

      {/* (P1) Configuration du boîtier — écrit /deviceConfig/{boxId}, le boîtier le tire par WiFi */}
      <Drawer closeOnOverlay={false}
        open={!!cfgEdit}
        onClose={closeConfig}
        title={cfgEdit ? `Unit ${cfgEdit.boxId}` : ''}
        subtitle="Pushed over WiFi (config-pull) · applied at the next WiFi session"
        footer={cfgEdit && (
          <>
            <Button variant="secondary" onClick={closeConfig} disabled={cfgSaving}>Cancel</Button>
            <Button variant="primary" onClick={saveConfig} disabled={!canPush}>
              {cfgSaving ? 'Pushing…' : 'Push to unit'}
            </Button>
          </>
        )}
      >
        {cfgEdit && (
          <div>
            {cfgError && <Banner tone="caution" title="Not pushed" style={{ marginBottom: 16 }}>{cfgError}</Banner>}

            <Section title="Identity" first>
              {cfgEdit.fromSheet ? (
                /* Fiche aéronef trouvée → UNE SEULE source : identité en lecture seule ici. */
                <div style={{ padding: '10px 12px', borderRadius: T.radius.sm, background: T.paper, border: T.border }}>
                  <div style={{ ...monoStyle(14), fontWeight: 500 }}>
                    {cfgEdit.reg}
                    <span style={{ color: T.graphite }}> · {cfgEdit.type || 'type ?'} · {cfgEdit.hex || 'no hex'}</span>
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.4, color: T.graphite, marginTop: 6 }}>
                    Managed by the aircraft record (Admin → Aircraft) and synced to the unit automatically.
                  </div>
                </div>
              ) : (
                <>
                  <Field label="REGISTRATION / CALLSIGN *" hint="No aircraft record — direct entry.">
                    <input className="ak-focus" value={cfgEdit.reg} onChange={e => setCfgEdit(c => ({ ...c, reg: e.target.value }))}
                      placeholder="OOI43" style={inputStyle} />
                  </Field>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    <Field label="ICAO TYPE" style={{ flex: '1 1 140px' }}>
                      <input className="ak-focus" value={cfgEdit.type} onChange={e => setCfgEdit(c => ({ ...c, type: e.target.value }))}
                        placeholder="FK9 / VL3…" style={inputStyle} />
                    </Field>
                    <Field label="HEX (IF TRANSPONDER)" style={{ flex: '1 1 140px' }}>
                      <input className="ak-focus" value={cfgEdit.hex} onChange={e => setCfgEdit(c => ({ ...c, hex: e.target.value }))}
                        placeholder="empty if no ADS-B" style={inputStyle} />
                    </Field>
                  </div>
                </>
              )}
              <div style={{ fontSize: 12, lineHeight: 1.5, color: T.graphite }}>
                Currently on the unit: <span style={monoStyle(12)}>{cfgEdit.reported.reg || '—'}{cfgEdit.reported.hex ? ` / ${cfgEdit.reported.hex}` : ''}{cfgEdit.reported.wifiSsid ? ` · WiFi ${cfgEdit.reported.wifiSsid}` : ''}</span>
              </div>
              {cfgEdit.hasConfig && <StatusDot tone="caution" text="A configuration is already pending" />}
            </Section>

            {/* (2026-09-20) Canal OTA du boîtier (ATC ≥210) : flotte (s3) ou dev (s3dev) ; son écran suit (ws241 / ws241dev). */}
            <Section title="Update channel">
              <Tabs
                ariaLabel="Update channel"
                tabs={[{ key: '', label: 'Unchanged' }, { key: 's3', label: 'Fleet' }, { key: 's3dev', label: 'Dev' }]}
                value={cfgEdit.otaTag}
                onChange={(k) => setCfgEdit(c => ({ ...c, otaTag: k }))}
              />
              <div style={{ fontSize: 12, lineHeight: 1.4, color: T.graphite }}>
                Fleet = <span style={monoStyle(12)}>s3</span>, Dev = <span style={monoStyle(12)}>s3dev</span>; the display follows.
                {cfgEdit.reported.board ? <> Currently <span style={monoStyle(12)}>{cfgEdit.reported.board}</span>.</> : null}
              </div>
            </Section>

            {/* (P2) WiFi club poussé au boîtier */}
            <Section title="Club WiFi">
              <div style={{ fontSize: 12, lineHeight: 1.4, color: T.graphite, marginTop: -6 }}>
                Optional. Becomes the unit's primary network.
              </div>
              <Field label="SSID">
                <input className="ak-focus" value={cfgEdit.wifiSsid} onChange={e => setCfgEdit(c => ({ ...c, wifiSsid: e.target.value }))}
                  placeholder="EBBY" style={inputStyle} />
              </Field>
              <Field label="PASSWORD" hint="The password is visible to designated dashboard members.">
                <input className="ak-focus" type="password" value={cfgEdit.wifiPass} autoComplete="new-password"
                  onChange={e => setCfgEdit(c => ({ ...c, wifiPass: e.target.value }))}
                  placeholder={cfgEdit.wifiSsid ? '••••••••' : ''} style={inputStyle} />
              </Field>
            </Section>

            {/* (2026-09-21) Réseaux WiFi connus du boîtier (rapport ATC ≥213, noms seuls) : une ligne par réseau, origine + réseau actif */}
            {knownNetworks.length > 0 && (
              <Section title="Known WiFi networks">
                <ol style={{ listStyle: 'none', margin: 0, padding: 0, border: T.border, borderRadius: T.radius.sm }}>
                  {knownNetworks.map((x, i) => {
                    const pilot = x.endsWith('*'); const name = pilot ? x.slice(0, -1) : x
                    const active = name.toLowerCase() === (cfgEdit.reported.wifiSsid || '').toLowerCase()
                    const marked = (cfgEdit.forget || []).includes(name)
                    return (
                      <li key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderTop: i ? T.border : 'none', flexWrap: 'wrap' }}>
                        <span style={{ ...monoStyle(12, T.etch), width: 18 }}>{i + 1}.</span>
                        <div style={{ flex: '1 1 120px', minWidth: 0 }}>
                          <div style={{ ...monoStyle(13, marked ? T.etch : T.ink), fontWeight: 500, textDecoration: marked ? 'line-through' : 'none', overflowWrap: 'anywhere' }}>{name}</div>
                          <div style={{ display: 'flex', gap: 10, marginTop: 3, flexWrap: 'wrap' }}>
                            <span style={monoStyle(11, T.graphite)}>{pilot ? 'pilot · protected' : 'dashboard'}</span>
                            {active && <StatusDot tone="ok" text="connected" />}
                            {marked && <StatusDot tone="caution" text="removal pending" />}
                          </div>
                        </div>
                        {/* Edit = pré-remplit le WiFi club ci-dessus (nouveau mot de passe) ; Remove = marque pour suppression, envoyée au Push */}
                        <Button size="sm" variant="secondary" title="Change this network's password"
                          onClick={() => setCfgEdit(c => ({ ...c, wifiSsid: name, wifiPass: '' }))}>Edit</Button>
                        <Button size="sm" variant={marked ? 'secondary' : 'danger'}
                          title={marked ? 'Cancel the removal' : 'Remove this network from the unit at its next WiFi session'}
                          onClick={() => setCfgEdit(c => ({ ...c, forget: marked ? c.forget.filter(y => y !== name) : [...(c.forget || []), name] }))}>
                          {marked ? 'Keep' : 'Remove'}
                        </Button>
                      </li>
                    )
                  })}
                </ol>
                <div style={{ fontSize: 12, lineHeight: 1.4, color: T.graphite }}>
                  Order = the unit's priority. A dashboard network is dropped before a pilot network when the list (6) overflows.
                  Removals are sent on Push and applied at the unit's next WiFi session (Core ≥ 214).
                </div>
              </Section>
            )}
          </div>
        )}
      </Drawer>
    </div>
  )
}
