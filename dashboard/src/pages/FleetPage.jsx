import { useState, useEffect } from 'react'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { ref as storageRef, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../firebase/config'
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

const ATC_TAGS = ['s3', 'wrover']
const ATV_TAGS = ['ws241', 't4s3', 'trgb', 'ws216']

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

// Badge version : vert si >= publiée, ambre (→ cible) si en retard, gris si inconnue.
function VerBadge({ cur, curStr, latest }) {
  if (cur == null) return <span style={{ color: C.low, fontFamily: C.mono, fontSize: 11 }}>— unknown</span>
  const known = typeof latest === 'number'
  const upToDate = known && cur >= latest
  const col = !known ? C.mid : upToDate ? C.green : C.amber
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 700, color: C.text }}>{curStr || `v${cur}`}</span>
      <span style={{
        fontFamily: C.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.04em',
        padding: '2px 6px', borderRadius: 4,
        background: `${col}1a`, color: col, border: `1px solid ${col}55`,
      }}>{!known ? '?' : upToDate ? 'UP TO DATE' : `→ v${latest}`}</span>
    </span>
  )
}

export default function FleetPage() {
  const { clubId } = useClub()
  const [devices, setDevices] = useState([])
  const [aircraft, setAircraft] = useState([])
  const [published, setPublished] = useState({})   // tag -> int (dernière version publiée)
  const [loading, setLoading] = useState(true)

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
    ]).then(([ds, as]) => {
      const acList = as.docs.map(d => ({ id: d.id, ...d.data() }))
      const devs = ds.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.callSign || a.boxId || a.id).localeCompare(b.callSign || b.boxId || b.id))
      setDevices(devs)
      setAircraft(acList)
      setLoading(false)
    }).catch(e => { console.error('[Fleet] load', e); setLoading(false) })
  }, [clubId])

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
            <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1.4fr 1.4fr 1.1fr 0.9fr', gap: 8, padding: '10px 16px', borderBottom: `1px solid ${C.border}`, fontFamily: C.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', color: C.mid }}>
              <div>BOX</div><div>AIRCRAFT</div><div>ATC FIRMWARE</div><div>ATV (screen)</div><div>OTA</div><div>LAST SEEN</div>
            </div>
            {devices.map(dev => {
              const ota = OTA_LABEL[dev.otaState] || OTA_LABEL.idle
              return (
                <div key={dev.id} style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr 1.4fr 1.4fr 1.1fr 0.9fr', gap: 8, padding: '12px 16px', borderBottom: `1px solid ${C.border}`, alignItems: 'center' }}>
                  <div>
                    <div style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 700 }}>{dev.boxId || dev.id}</div>
                    <div style={{ fontFamily: C.mono, fontSize: 9, color: C.mid }}>{dev.board || '?'}{dev.wifiSsid ? ` · ${dev.wifiSsid}` : ''}</div>
                  </div>
                  <div style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 600 }}>{callSignOf(dev)}</div>
                  <VerBadge cur={dev.fwVersion} curStr={dev.fwVersionStr} latest={published[dev.board]} />
                  <VerBadge cur={dev.atvVersion} curStr={dev.atvVersion != null ? `v${dev.atvVersion}` : null} latest={published[`atv_${dev.atvTag}`]} />
                  <div style={{ fontFamily: C.mono, fontSize: 10, fontWeight: 700, color: ota.c }}>{ota.t}</div>
                  <div style={{ fontFamily: C.mono, fontSize: 10, color: C.mid }}>{fmtSeen(dev.lastSeen || dev.updatedAt)}</div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
