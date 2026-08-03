import { useState, useEffect } from 'react'
import { collection, getDocs, query, where, doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { ref as storageRef, getDownloadURL } from 'firebase/storage'
import { httpsCallable } from 'firebase/functions'
import { db, storage, auth, functions } from '../firebase/config'
import { useClub } from '../contexts/ClubContext'

// ─── FleetPage — état firmware de la flotte de boîtiers (ATC) + écrans (ATV) ────
// Vue read-only (admin + super_admin). Lit /devices/{boxId} (écrit par le boîtier
// pendant ses sessions WiFi : upload post-vol + fin d'OTA) et compare la version
// courante à la DERNIÈRE version PUBLIÉE sur Firebase Storage (firmware/<tag>/version.txt)
// → badge « à jour » / « en retard ». La version firmware ne changeant qu'à l'update
// (sur WiFi, où elle est justement enregistrée), la valeur affichée est fiable.
//
// Schéma /devices/{boxId} attendu (écrit par le firmware, à venir) :
//   { boxId, clubId, callSign, icao24, board:'s3'|'wrover', fwVersion:int, fwVersionStr,
//     atvVersion:int, atvTag:'ws241'|'t4s3'|'trgb'|'ws216', otaState, wifiSsid,
//     lastSeen:Timestamp, updatedAt:Timestamp }

const C = {
  bg: '#f4f5f7', surface: '#ffffff', border: 'rgba(10,14,30,0.10)',
  text: '#0a0e1e', mid: 'rgba(10,14,30,0.55)', low: 'rgba(10,14,30,0.30)',
  mono: 'monospace', amber: '#F5A623', green: '#22c55e', red: '#ef4444', blue: '#60a5fa',
}

const ATC_TAGS = ['s3', 'wrover', 's3dev']
const ATV_TAGS = ['ws241', 't4s3', 'trgb', 'ws216', 'ws241dev']
// (T30) tag écran déduit du board boîtier quand dev.atvTag est absent : boîtier de banc (s3dev)
// → écran de banc (ws241dev) ; sinon ws241 (flotte WS-241).
const atvTagForBoard = (board) => board === 's3dev' ? 'ws241dev' : 'ws241'

const OTA_LABEL = {
  idle: { t: 'idle', c: C.mid }, available: { t: 'update available', c: C.amber },
  downloading: { t: 'downloading…', c: C.blue }, ok: { t: 'up to date ✓', c: C.green },
  failed: { t: 'failed', c: C.red },
}

function tsMillis(v) {
  if (!v) return 0
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v
  return v.toMillis?.() ?? 0
}
function fmtMB(mb) {
  if (mb == null) return '—'
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`
}
const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
function monthLabel(key) {   // "2026-07" → "juillet 2026"
  if (!key || !/^\d{4}-\d{2}$/.test(key)) return 'Mois en cours'
  const [y, m] = key.split('-')
  return `${FR_MONTHS[+m - 1]} ${y}`
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

// Badge version : petit ✓ vert si à jour, pastille ambre « → vN » si en retard,
// rien (version seule) si la version publiée est inconnue.
function VerBadge({ cur, curStr, latest, fleetMax }) {
  if (cur == null) return <span style={{ color: C.low, fontFamily: C.mono, fontSize: 11 }}>—</span>
  const known = typeof latest === 'number'
  const upToDate = known && cur >= latest
  // (2026-08-03) « périmé vs PARC » : à jour sur son tag OTA mais un build PLUS RÉCENT roule déjà
  // sur un autre appareil (flash USB dev, pas encore béni/publié) → badge gris discret.
  const behindFleet = typeof fleetMax === 'number' && fleetMax > cur && (!known || cur >= latest)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 700, color: C.text }}>{curStr || `v${cur}`}</span>
      {behindFleet && (
        <span title={`un build plus récent roule dans le parc : v${fleetMax} (dev, non publié sur le tag OTA)`} style={{
          fontFamily: C.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.04em',
          padding: '2px 6px', borderRadius: 4,
          background: `${C.low}14`, color: C.low, border: `1px solid ${C.low}44`,
        }}>← v{fleetMax} dev</span>
      )}
      {known && (upToDate ? (
        <span title={`à jour (v${latest})`} style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 15, height: 15, borderRadius: '50%', flex: '0 0 auto',
          background: C.green, color: '#fff', fontSize: 10, fontWeight: 900, lineHeight: 1,
        }}>✓</span>
      ) : (
        <span title={`mise à jour dispo : v${latest}`} style={{
          fontFamily: C.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.04em',
          padding: '2px 6px', borderRadius: 4,
          background: `${C.amber}1a`, color: C.amber, border: `1px solid ${C.amber}55`,
        }}>→ v{latest}</span>
      ))}
    </span>
  )
}

export default function FleetPage() {
  const { clubId } = useClub()
  const [devices, setDevices] = useState([])
  const [aircraft, setAircraft] = useState([])
  const [published, setPublished] = useState({})   // tag -> int (dernière version publiée)
  const [loading, setLoading] = useState(true)
  const [cfgEdit, setCfgEdit] = useState(null)     // (P1) config-pull : {boxId, reg, type, hex, reported:{...}} ou null
  const [cfgSaving, setCfgSaving] = useState(false)
  const [emnify, setEmnify] = useState(null)
  // (2026-08-03) version max VUE dans le parc (FW_VERSION/VIEW_VERSION monotones toutes cartes)
  const fleetMaxFw  = devices.reduce((m, d) => Math.max(m, d.fwVersion  || 0), 0)
  const fleetMaxAtv = devices.reduce((m, d) => Math.max(m, d.atvVersion || 0), 0)       // (P3) /fleetMeta/emnify : { totalUsedMB, poolTotalMB, updatedAt… }
  const [refreshing, setRefreshing] = useState(false)

  // (fix modale) Échap ferme l'éditeur config (sauf pendant l'enregistrement).
  useEffect(() => {
    if (!cfgEdit) return
    const onKey = (e) => { if (e.key === 'Escape' && !cfgSaving) setCfgEdit(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cfgEdit, cfgSaving])

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
      alert('Conso EMnify : ' + (e.message || e.code || 'échec') +
        (String(e.message || '').includes('EMNIFY_APP_TOKEN') ? '\n\nConfigure le token : firebase functions:secrets:set EMNIFY_APP_TOKEN' : ''))
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
    setCfgEdit({
      boxId,
      reg:  cfg.reg  ?? dev.callSign ?? '',
      type: cfg.type ?? '',
      hex:  cfg.hex  ?? (dev.icao24 || ''),
      wifiSsid: cfg.wifiSsid ?? '',
      wifiPass: cfg.wifiPass ?? '',
      reported: { reg: dev.callSign || '', hex: dev.icao24 || '', wifiSsid: dev.wifiSsid || '' },
      hasConfig: !!(cfg.reg || cfg.wifiSsid),
    })
  }
  const saveConfig = async () => {
    if (!cfgEdit) return
    const reg = (cfgEdit.reg || '').trim().toUpperCase()
    const wifiSsid = (cfgEdit.wifiSsid || '').trim()
    if (!reg && !wifiSsid) return
    const type = (cfgEdit.type || '').trim().toUpperCase()
    const hex  = (cfgEdit.hex  || '').trim().toUpperCase()
    setCfgSaving(true)
    try {
      const email = auth.currentUser?.email || null
      // (v108) IDENTITÉ dans un doc PUBLIC (reg/type/hex) → le boîtier la lit en 1 TLS SANS auth
      // (pas de kill-BLE/reboot). JAMAIS de WiFi ici (pass sensible). Écrit seulement si reg fourni.
      if (reg) {
        await setDoc(doc(db, 'deviceConfigPublic', cfgEdit.boxId), {
          boxId: cfgEdit.boxId, reg, type, hex, updatedAt: serverTimestamp(), updatedBy: email,
        }, { merge: true })
      }
      // Doc AUTH complet (WiFi + trace/affichage). Le boîtier lit le WiFi ici (best-effort, auth).
      await setDoc(doc(db, 'deviceConfig', cfgEdit.boxId), {
        boxId: cfgEdit.boxId, reg, type, hex,
        wifiSsid, wifiPass: cfgEdit.wifiPass || '',
        updatedAt: serverTimestamp(), updatedBy: email,
      }, { merge: true })
      // Reflète tout de suite l'immat DÉSIRÉE dans la liste (le report /devices peut retarder).
      setDevices(ds => ds.map(d => (d.boxId || d.id) === cfgEdit.boxId ? { ...d, desiredCallSign: reg || d.desiredCallSign } : d))
      setCfgEdit(null)
    } catch (e) {
      console.error('[Fleet] saveConfig', e)
      alert('Échec de l\'enregistrement : ' + (e.code || e.message || e) +
        (String(e.code || '').includes('permission') ? '\n\n(Ton compte doit être admin/super_admin pour écrire la config.)' : ''))
    }
    finally { setCfgSaving(false) }
  }

  const callSignOf = (dev) => {
    if (dev.callSign) return dev.callSign
    const a = aircraft.find(x => (dev.icao24 && x.icao24?.toUpperCase() === dev.icao24.toUpperCase()))
    return a ? (a.callSign || a.registration) : '—'
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: C.bg, color: C.text, padding: '20px 24px' }}>
      <div style={{ maxWidth: 1040, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Fleet · firmware</h1>
          <span style={{ fontSize: 11, color: C.mid, fontFamily: C.mono }}>admin</span>
        </div>
        <p style={{ fontSize: 12.5, color: C.mid, marginTop: 4 }}>
          État firmware de chaque boîtier (ATC) et de son écran (ATV). Mis à jour quand le boîtier
          touche du WiFi (upload post-vol / fin d'OTA). Publié en prod :{' '}
          {ATC_TAGS.map(t => `${t} v${published[t] ?? '?'}`).join(' · ')}.
        </p>

        {/* (P3) Récap conso data EMnify — lu en direct depuis EMnify (rien cumulé chez nous) */}
        <div style={{ marginTop: 12, padding: '14px 16px', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontFamily: C.mono, fontWeight: 700, letterSpacing: '0.06em', color: C.mid }}>DATA · EMNIFY (flotte)</div>
            <div style={{ fontSize: 10.5, color: C.low, fontFamily: C.mono }}>
              {emnify ? `${emnify.matchedCount ?? 0} SIM · maj ${fmtSeen(emnify.updatedAt)}` : 'jamais synchronisé'}
            </div>
            <button onClick={refreshEmnify} disabled={refreshing}
              style={{ marginLeft: 'auto', padding: '7px 14px', borderRadius: 8, background: C.text, border: 'none', color: '#fff', cursor: refreshing ? 'default' : 'pointer', fontFamily: C.mono, fontSize: 11, fontWeight: 700, opacity: refreshing ? 0.6 : 1 }}>
              {refreshing ? 'Sync…' : 'Rafraîchir la conso'}
            </button>
          </div>
          {(() => {
            const pool = emnify?.poolTotalMB, month = emnify?.totalUsedMB
            const pct = (pool && month != null) ? Math.min(100, Math.round(month / pool * 100)) : null
            const col = pct == null ? C.mid : pct >= 90 ? C.red : pct >= 70 ? C.amber : C.green
            const cur = emnify?.currency || 'EUR'
            const Tile = ({ label, mb, cost, sub, accent }) => (
              <div style={{ flex: '1 1 130px', padding: '10px 12px', borderRadius: 9, background: accent ? `${C.blue}0f` : 'rgba(10,14,30,0.03)', border: `1px solid ${accent ? C.blue + '33' : C.border}` }}>
                <div style={{ fontSize: 9, fontFamily: C.mono, fontWeight: 700, letterSpacing: '0.05em', color: C.mid, textTransform: 'uppercase' }}>{label}</div>
                <div style={{ fontSize: 17, fontWeight: 700, fontFamily: C.mono, color: C.text, marginTop: 3 }}>{mb != null ? fmtMB(mb) : '—'}</div>
                {cost != null && <div style={{ fontSize: 12, fontWeight: 700, fontFamily: C.mono, color: C.green }}>{cost.toFixed(2)} {cur}</div>}
                {sub && <div style={{ fontSize: 9.5, color: C.low, fontFamily: C.mono, marginTop: 2 }}>{sub}</div>}
              </div>
            )
            return (
              <>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  <Tile label="Overall" mb={emnify?.overallMB} sub="depuis l'activation" />
                  <Tile label={emnify?.year || '2026'} mb={emnify?.yearMB} sub="année en cours" />
                  <Tile label={monthLabel(emnify?.monthKey)} mb={month} cost={emnify?.totalCost} accent sub="mois en cours" />
                  <Tile label="Dernier jour" mb={emnify?.lastDayMB} sub={emnify?.lastDayDate || ''} />
                </div>
                {pct != null && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
                    <div style={{ fontSize: 10, fontFamily: C.mono, color: C.mid }}>Pool {monthLabel(emnify?.monthKey)}</div>
                    <div style={{ flex: '1 1 auto', maxWidth: 340, height: 8, borderRadius: 4, background: 'rgba(10,14,30,0.08)', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: col }} />
                    </div>
                    <div style={{ fontSize: 11, fontFamily: C.mono, fontWeight: 700, color: col }}>{pct}% de {fmtMB(pool)}</div>
                  </div>
                )}
              </>
            )
          })()}
        </div>

        {loading && <div style={{ color: C.low, fontSize: 12, paddingTop: 30 }}>Chargement…</div>}
        {!loading && !clubId && <div style={{ color: C.low, fontSize: 12 }}>Sélectionne un club d'abord.</div>}
        {!loading && clubId && devices.length === 0 && (
          <div style={{ color: C.mid, fontSize: 12.5, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 18, marginTop: 14 }}>
            Aucun boîtier n'a encore rapporté son état. Un boîtier apparaîtra ici dès sa première session
            WiFi (upload post-vol ou update). <span style={{ color: C.low }}>(Le firmware qui écrit <code>/devices</code> est à venir.)</span>
          </div>
        )}

        {!loading && devices.length > 0 && (
          <div style={{ marginTop: 16, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 0.9fr 1.15fr 1.15fr 0.85fr 0.7fr 0.7fr 0.7fr', gap: 8, padding: '10px 16px', borderBottom: `1px solid ${C.border}`, fontFamily: C.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', color: C.mid }}>
              <div>BOX</div><div>AIRCRAFT</div><div>ATC FIRMWARE</div><div>ATV (screen)</div><div>OTA</div><div>DATA/MOIS</div><div>COÛT/MOIS</div><div>LAST SEEN</div>
            </div>
            {devices.map(dev => {
              // OTA : quand rien n'est en cours (idle) ET l'ATC est à jour → « à jour » (vert)
              // au lieu du « idle » peu parlant. Sinon on garde l'état OTA live (available/downloading…).
              const atcLatest = published[dev.board]
              const atcUpToDate = typeof atcLatest === 'number' && dev.fwVersion >= atcLatest
              const otaState = dev.otaState || 'idle'
              const ota = (otaState === 'idle' && atcUpToDate)
                ? { t: 'à jour', c: C.green }
                : (OTA_LABEL[otaState] || OTA_LABEL.idle)
              // Version ATV publiée : par tag écran si connu, sinon la + haute des tags ATV
              // publiés (tous les écrans partagent le même train VIEW_VERSION) → plus de « ? ».
              const atvNums = ATV_TAGS.map(t => published[`atv_${t}`]).filter(v => typeof v === 'number')
              const atvLatest = published[`atv_${dev.atvTag || atvTagForBoard(dev.board)}`] ?? (atvNums.length ? Math.max(...atvNums) : undefined)
              // Chaîne ATV complète « comme l'ATC » : le train MAJOR.MINOR est PARTAGÉ ATC↔ATV
              // (versioning AeroTrace) → préfixe train + suffixe canal de l'ATC, build ATV substitué.
              // Ex ATC "1.2.105-dev" + atv 191 → "1.2.191-dev". (dev.atvVersionStr prévaut si un jour remonté.)
              // \w+ (et non \d+) : le train BANC est « X.1 » (ATC v141) — l'ancien regex chiffres-seuls
              // ne matchait pas → la colonne ATV affichait la version ATC telle quelle (ex X.1.142 au lieu de X.1.204).
              const atvVerStr = dev.atvVersionStr
                || (dev.fwVersionStr && dev.atvVersion
                    ? dev.fwVersionStr.replace(/^(\w+\.\w+\.)\d+/, `$1${dev.atvVersion}`)
                    : (dev.atvVersion ? `v${dev.atvVersion}` : null))
              return (
                <div key={dev.id} style={{ display: 'grid', gridTemplateColumns: '1fr 0.9fr 1.15fr 1.15fr 0.85fr 0.7fr 0.7fr 0.7fr', gap: 8, padding: '12px 16px', borderBottom: `1px solid ${C.border}`, alignItems: 'center' }}>
                  <div>
                    <div style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 700 }}>{dev.boxId || dev.id}</div>
                    <div style={{ fontFamily: C.mono, fontSize: 9, color: C.mid }}>{dev.board || '?'}{dev.wifiSsid ? ` · ${dev.wifiSsid}` : ''}</div>
                  </div>
                  {(() => {
                    const reported = callSignOf(dev)
                    const pending = dev.desiredCallSign && dev.desiredCallSign !== reported
                    return (
                      <div onClick={() => openConfig(dev)}
                        title={pending ? `Poussé : ${dev.desiredCallSign} (le boîtier l'applique à sa prochaine session WiFi)` : "Éditer l'identité — poussée au boîtier"}
                        style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 600, cursor: 'pointer', color: C.blue }}>
                        {pending ? dev.desiredCallSign : reported} <span style={{ fontSize: 10, opacity: 0.6 }}>✎</span>
                        {pending && <div style={{ fontSize: 8.5, color: C.amber, fontWeight: 700 }}>→ en attente (était {reported})</div>}
                      </div>
                    )
                  })()}
                  <VerBadge cur={dev.fwVersion} curStr={dev.fwVersionStr} latest={published[dev.board]} fleetMax={fleetMaxFw} />
                  <VerBadge cur={dev.atvVersion} curStr={atvVerStr} latest={atvLatest} fleetMax={fleetMaxAtv} />
                  <div style={{ fontFamily: C.mono, fontSize: 10, fontWeight: 700, color: ota.c }}>{ota.t}</div>
                  <div title={[
                        dev.iccid ? `ICCID ${dev.iccid}` : (dev.emnifyName ? `EMnify: ${dev.emnifyName}` : 'non lié à une SIM'),
                        dev.simStatus ? `SIM ${dev.simStatus}` : '',
                        dev.yearMB != null ? `Année: ${fmtMB(dev.yearMB)}` : '',
                        dev.overallMB != null ? `Overall: ${fmtMB(dev.overallMB)}` : '',
                        dev.lastDayMB != null ? `Dernier jour (${dev.lastDayDate || '?'}): ${fmtMB(dev.lastDayMB)}` : '',
                      ].filter(Boolean).join('\n')}>
                    <div style={{ fontFamily: C.mono, fontSize: 11, fontWeight: 600, color: dev.dataUsageMB != null ? C.text : C.low }}>
                      {dev.dataUsageMB != null ? fmtMB(dev.dataUsageMB) : (dev.iccid || dev.emnifyName ? '—' : '·')}
                    </div>
                    {dev.overallMB != null && <div style={{ fontFamily: C.mono, fontSize: 8.5, color: C.low }}>Σ {fmtMB(dev.overallMB)}</div>}
                  </div>
                  <div style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 700, color: dev.dataCost ? C.green : C.low }}>
                    {dev.dataCost != null ? `${dev.dataCost.toFixed(2)} ${dev.dataCostCur || 'EUR'}` : '—'}
                  </div>
                  <div style={{ fontFamily: C.mono, fontSize: 10, color: C.mid }}>{fmtSeen(dev.lastSeen || dev.updatedAt)}</div>
                </div>
              )
            })}
          </div>
        )}

        {/* (P1) Éditeur d'identité aéronef — écrit /deviceConfig/{boxId}, le boîtier le tire par WiFi */}
        {cfgEdit && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
            {/* (fix) la modale ne se ferme plus sur un clic-fond parasite (elle « sautait toute seule »)
                → fermeture UNIQUEMENT par ✕ / Annuler / Échap. Pas de onClick sur le fond. */}
            <div style={{ background: C.surface, borderRadius: 14, padding: 22, width: 420, maxWidth: '92vw', boxShadow: '0 10px 40px rgba(0,0,0,0.3)', position: 'relative' }}>
              <button onClick={() => !cfgSaving && setCfgEdit(null)} title="Fermer" aria-label="Fermer"
                style={{ position: 'absolute', top: 12, right: 12, width: 26, height: 26, borderRadius: 6, border: `1px solid ${C.border}`, background: 'transparent', color: C.mid, cursor: 'pointer', fontSize: 15, lineHeight: 1 }}>×</button>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Config boîtier — <span style={{ fontFamily: C.mono }}>{cfgEdit.boxId}</span></div>
              <div style={{ fontSize: 11.5, color: C.mid, marginTop: 4, lineHeight: 1.5 }}>
                Poussée au boîtier par WiFi (config-pull). S'applique à sa prochaine session WiFi
                (boot / Report to fleet) → ré-inscription SafeSky automatique.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 10, color: C.mid, fontWeight: 700 }}>IMMATRICULATION / CALLSIGN *</span>
                  <input value={cfgEdit.reg} autoFocus onChange={e => setCfgEdit(c => ({ ...c, reg: e.target.value }))}
                    placeholder="OOI43" style={inputStyle} />
                </label>
                <div style={{ display: 'flex', gap: 12 }}>
                  <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 10, color: C.mid, fontWeight: 700 }}>TYPE OACI</span>
                    <input value={cfgEdit.type} onChange={e => setCfgEdit(c => ({ ...c, type: e.target.value }))}
                      placeholder="FK9 / VL3…" style={inputStyle} />
                  </label>
                  <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 10, color: C.mid, fontWeight: 700 }}>HEX (si transpondeur)</span>
                    <input value={cfgEdit.hex} onChange={e => setCfgEdit(c => ({ ...c, hex: e.target.value }))}
                      placeholder="(vide si pas d'ADS-B)" style={inputStyle} />
                  </label>
                </div>

                {/* (P2) WiFi club poussé au boîtier */}
                <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <span style={{ fontSize: 10, color: C.mid, fontWeight: 700, letterSpacing: '0.05em' }}>WIFI CLUB (optionnel) — devient le réseau primaire du boîtier</span>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 10, color: C.mid, fontWeight: 700 }}>SSID</span>
                    <input value={cfgEdit.wifiSsid} onChange={e => setCfgEdit(c => ({ ...c, wifiSsid: e.target.value }))}
                      placeholder="EBBY" style={inputStyle} />
                  </label>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{ fontSize: 10, color: C.mid, fontWeight: 700 }}>MOT DE PASSE</span>
                    <input type="password" value={cfgEdit.wifiPass} autoComplete="new-password"
                      onChange={e => setCfgEdit(c => ({ ...c, wifiPass: e.target.value }))}
                      placeholder={cfgEdit.wifiSsid ? '••••••••' : ''} style={inputStyle} />
                  </label>
                  <div style={{ fontSize: 10, color: C.low, lineHeight: 1.4 }}>
                    ⚠️ Le mot de passe est visible par les membres désignés du dashboard.
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 10.5, color: C.low, marginTop: 10 }}>
                Actuel sur le boîtier : <b>{cfgEdit.reported.reg || '—'}</b>{cfgEdit.reported.hex ? ` / ${cfgEdit.reported.hex}` : ''}{cfgEdit.reported.wifiSsid ? ` · WiFi ${cfgEdit.reported.wifiSsid}` : ''}
                {cfgEdit.hasConfig && <span style={{ color: C.amber }}> · une config est déjà en attente</span>}
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 18 }}>
                <button onClick={() => setCfgEdit(null)} disabled={cfgSaving}
                  style={{ padding: '8px 16px', borderRadius: 8, background: 'transparent', border: `1px solid ${C.border}`, color: C.mid, cursor: 'pointer', fontFamily: C.mono, fontSize: 11 }}>Annuler</button>
                <button onClick={saveConfig} disabled={cfgSaving || (!cfgEdit.reg.trim() && !cfgEdit.wifiSsid.trim())}
                  style={{ padding: '8px 18px', borderRadius: 8, background: C.text, border: 'none', color: '#fff', cursor: 'pointer', fontFamily: C.mono, fontSize: 11, fontWeight: 700 }}>
                  {cfgSaving ? '…' : 'Pousser au boîtier'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const inputStyle = { padding: '8px 10px', borderRadius: 7, border: '1px solid rgba(10,14,30,0.15)', fontFamily: 'monospace', fontSize: 13, color: '#0a0e1e', width: '100%', boxSizing: 'border-box' }
