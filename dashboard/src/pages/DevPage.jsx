import { useState, useEffect, useRef } from 'react'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { ref as storageRef, getDownloadURL, uploadBytes } from 'firebase/storage'
import { db, storage } from '../firebase/config'
import { useClub } from '../contexts/ClubContext'

// ─── DevPage — outils dev : check LTE d'un vol, upload fichiers LTE, export simu ──
// Réservé super_admin (route gardée dans App.jsx). Le fichier LTE d'un vol est
// stocké en flights_lte/<fid>.csv (colonnes : ts_utc,lat,lon,alt_m,spd_kt,hdg_deg,
// tech,operator,band,earfcn,cell_id,pcid,tac,rsrp_dbm,rsrq_db,rssi_dbm,sinr_db,
// csq_rssi,fix_ok). Le CSV de vol (flights/<fid>.csv) est directement chargeable
// dans le simulateur d'alertes (altsim, sélecteurs own/intrus).

const C = {
  bg: '#f4f5f7', surface: '#ffffff', border: 'rgba(10,14,30,0.10)',
  text: '#0a0e1e', mid: 'rgba(10,14,30,0.55)', low: 'rgba(10,14,30,0.30)',
  mono: 'monospace', amber: '#F5A623', green: '#22c55e', red: '#ef4444',
}

function median(a) { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }

// Parse un CSV LTE → stats + points {lat,lon,csq,svc}.
function parseLte(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length)
  // en-tête : ligne #lte_log (0) + ligne de colonnes (1) → data à partir de 2
  let hi = lines.findIndex(l => /ts_utc/i.test(l))
  if (hi < 0) hi = 1
  const cols = lines[hi].split(',').map(s => s.trim().toLowerCase())
  const ci = (n) => cols.indexOf(n)
  const iLat = ci('lat'), iLon = ci('lon'), iTech = ci('tech'), iOp = ci('operator'),
        iCsq = ci('csq_rssi'), iRsrp = ci('rsrp_dbm'), iSinr = ci('sinr_db'), iFix = ci('fix_ok')
  let tot = 0, svc = 0, fix = 0
  const csqs = [], ops = {}, pts = []
  for (let k = hi + 1; k < lines.length; k++) {
    const c = lines[k].split(','); if (c.length < 7) continue
    tot++
    const tech = (c[iTech] || '').trim()
    const isLte = tech === 'LTE'
    if (isLte) svc++
    if (iFix >= 0 && c[iFix]?.trim() === '1') fix++
    const op = (c[iOp] || '').trim() || '—'
    ops[op] = (ops[op] || 0) + 1
    const csq = iCsq >= 0 ? parseInt(c[iCsq], 10) : NaN
    if (csq >= 0 && csq <= 31) csqs.push(csq)
    const la = parseFloat(c[iLat]), lo = parseFloat(c[iLon])
    if (isFinite(la) && isFinite(lo) && (la || lo)) pts.push({ lat: la, lon: lo, csq: isFinite(csq) ? csq : -1, svc: isLte })
  }
  const opList = Object.entries(ops).sort((a, b) => b[1] - a[1]).slice(0, 6)
  return { tot, svcPct: tot ? Math.round(100 * svc / tot) : 0, fixPct: tot ? Math.round(100 * fix / tot) : 0,
           csqMed: median(csqs), csqN: csqs.length, ops: opList, pts }
}

// Route colorée par qualité signal.
function RouteCanvas({ pts }) {
  const ref = useRef(null)
  useEffect(() => {
    const cv = ref.current; if (!cv || !pts.length) return
    const W = cv.width, H = cv.height, ctx = cv.getContext('2d')
    ctx.clearRect(0, 0, W, H)
    let minLa = 1e9, maxLa = -1e9, minLo = 1e9, maxLo = -1e9
    for (const p of pts) { minLa = Math.min(minLa, p.lat); maxLa = Math.max(maxLa, p.lat); minLo = Math.min(minLo, p.lon); maxLo = Math.max(maxLo, p.lon) }
    const pad = 10, cosL = Math.cos((minLa + maxLa) / 2 * Math.PI / 180)
    const spanLo = Math.max(1e-4, (maxLo - minLo) * cosL), spanLa = Math.max(1e-4, maxLa - minLa)
    const sc = Math.min((W - 2 * pad) / spanLo, (H - 2 * pad) / spanLa)
    const px = (p) => pad + (p.lon - minLo) * cosL * sc
    const py = (p) => H - pad - (p.lat - minLa) * sc
    for (const p of pts) {
      ctx.fillStyle = !p.svc ? C.red : p.csq < 0 ? '#94a3b8' : p.csq >= 18 ? C.green : p.csq >= 10 ? C.amber : C.red
      ctx.fillRect(px(p) - 1, py(p) - 1, 2.4, 2.4)
    }
  }, [pts])
  return <canvas ref={ref} width={520} height={230} style={{ width: '100%', maxWidth: 520, background: '#0d1117', borderRadius: 8 }} />
}

function KPI({ n, l, color }) {
  return <div style={{ background: C.bg, borderRadius: 8, padding: '10px 14px', minWidth: 92 }}>
    <div style={{ fontSize: 22, fontWeight: 700, color: color || C.text, fontVariantNumeric: 'tabular-nums' }}>{n}</div>
    <div style={{ fontSize: 10, color: C.mid, marginTop: 2 }}>{l}</div>
  </div>
}

export default function DevPage() {
  const { clubId } = useClub()
  const [flights, setFlights] = useState([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState(null)      // flight sélectionné
  const [lte, setLte] = useState(null)      // stats LTE parsées
  const [busy, setBusy] = useState('')      // message d'état
  const fileRef = useRef(null)

  useEffect(() => {
    if (!clubId) { setLoading(false); return }
    setLoading(true)
    getDocs(query(collection(db, 'flights'), where('clubId', '==', clubId)))
      .then(s => {
        const f = s.docs.map(d => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (tsOf(b) - tsOf(a)))
        setFlights(f); setLoading(false)
      }).catch(e => { console.error('[Dev] load', e); setLoading(false) })
  }, [clubId])

  const fidOf = (f) => f.flight_id || f.id

  // Télécharge un objet Storage (déclenche le download navigateur).
  const download = async (path, filename) => {
    setBusy('Downloading…')
    try {
      const url = await getDownloadURL(storageRef(storage, path))
      const a = document.createElement('a'); a.href = url; a.download = filename; a.target = '_blank'
      document.body.appendChild(a); a.click(); a.remove(); setBusy('')
    } catch (e) { setBusy(e.code === 'storage/object-not-found' ? 'Fichier absent sur le serveur' : e.message) }
  }

  // Analyse LTE : récupère flights_lte/<fid>.csv → parse → stats.
  const analyzeLte = async (f) => {
    setSel(f); setLte(null); setBusy('Loading LTE…')
    try {
      const url = await getDownloadURL(storageRef(storage, `flights_lte/${fidOf(f)}.csv`))
      const txt = await (await fetch(url)).text()
      setLte(parseLte(txt)); setBusy('')
    } catch (e) {
      setBusy(e.code === 'storage/object-not-found' ? 'Aucun fichier LTE — uploade-le d’abord.' : e.message)
    }
  }

  const uploadLte = async (f, file) => {
    if (!file) return
    setSel(f); setBusy('Uploading LTE…')
    try {
      await uploadBytes(storageRef(storage, `flights_lte/${fidOf(f)}.csv`), file, { contentType: 'text/csv' })
      setBusy('Upload OK — analyzing…')
      const txt = await file.text(); setLte(parseLte(txt)); setBusy('')
    } catch (e) { setBusy(e.message) }
  }

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: C.bg, padding: '20px 24px', color: C.text }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>Dev · LTE &amp; Simulateur</h1>
          <span style={{ fontSize: 11, color: C.mid, fontFamily: C.mono }}>super_admin</span>
        </div>
        <p style={{ fontSize: 12.5, color: C.mid, marginTop: 4 }}>
          Vérifier la capture LTE d’un vol (couverture, signal, opérateurs), uploader le fichier LTE
          sur le serveur, et récupérer le CSV pour le charger dans le simulateur d’alertes.
        </p>

        {busy && <div style={{ fontSize: 12, color: C.amber, margin: '8px 0', fontFamily: C.mono }}>{busy}</div>}

        {loading && <div style={{ color: C.low, fontSize: 12, paddingTop: 30 }}>Chargement…</div>}
        {!loading && !clubId && <div style={{ color: C.low, fontSize: 12 }}>Sélectionne un club d’abord.</div>}
        {!loading && clubId && flights.length === 0 && <div style={{ color: C.low, fontSize: 12 }}>Aucun vol pour ce club.</div>}

        {/* Panneau d'analyse LTE */}
        {sel && lte && (
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 18, margin: '14px 0' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>
              LTE — {sel.aircraftIdent || sel.aircraft_ident || fidOf(sel)} <span style={{ color: C.mid, fontFamily: C.mono, fontWeight: 400 }}>{fidOf(sel)}</span>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14 }}>
              <KPI n={`${lte.svcPct}%`} l="couverture LTE" color={lte.svcPct >= 70 ? C.green : lte.svcPct >= 40 ? C.amber : C.red} />
              <KPI n={`${lte.fixPct}%`} l="fix GPS" color={lte.fixPct >= 90 ? C.green : C.amber} />
              <KPI n={lte.csqMed} l="csq médian" color={lte.csqMed >= 18 ? C.green : lte.csqMed >= 10 ? C.amber : C.red} />
              <KPI n={lte.tot} l="échantillons" />
            </div>
            <RouteCanvas pts={lte.pts} />
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10, fontSize: 11, color: C.mid }}>
              <span><b style={{ color: C.green }}>■</b> csq≥18</span>
              <span><b style={{ color: C.amber }}>■</b> 10–17</span>
              <span><b style={{ color: C.red }}>■</b> faible / no-service</span>
              <span><b style={{ color: '#94a3b8' }}>■</b> csq n/a</span>
            </div>
            <div style={{ marginTop: 12, fontSize: 11.5 }}>
              <span style={{ color: C.mid }}>Opérateurs : </span>
              {lte.ops.map(([op, n]) => <span key={op} style={{ fontFamily: C.mono, marginRight: 12 }}>{op} <b>{Math.round(100 * n / lte.tot)}%</b></span>)}
            </div>
          </div>
        )}

        {/* Liste des vols */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {flights.map(f => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: C.surface, border: `1px solid ${sel?.id === f.id ? C.amber : C.border}`, borderRadius: 8, padding: '10px 14px' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {f.aircraftIdent || f.aircraft_ident || '—'} <span style={{ color: C.mid, fontFamily: C.mono, fontWeight: 400, fontSize: 11 }}>{fidOf(f)}</span>
                </div>
                <div style={{ fontSize: 11, color: C.mid }}>
                  {fmtDate(f)} · {(f.depIcao || '?')}→{(f.arrIcao || '?')} · {f.duration ? Math.round(f.duration / 60) + ' min' : '—'}
                </div>
              </div>
              <button onClick={() => download(`flights/${fidOf(f)}.csv`, `${fidOf(f)}.csv`)}
                title="Télécharger le CSV vol (chargeable dans le simulateur)"
                style={btn(C.text, '#fff')}>CSV → SIMU</button>
              <button onClick={() => analyzeLte(f)} style={btn('transparent', C.text, C.border)}>CHECK LTE</button>
              <label style={{ ...btnStyle('transparent', C.mid, C.border), cursor: 'pointer' }}>
                UPLOAD LTE
                <input type="file" accept=".csv" ref={fileRef} style={{ display: 'none' }}
                  onChange={e => { uploadLte(f, e.target.files[0]); e.target.value = '' }} />
              </label>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const btnStyle = (bg, col, bd) => ({ padding: '7px 12px', borderRadius: 7, background: bg, border: bd ? `1px solid ${bd}` : 'none', color: col, fontFamily: 'monospace', fontSize: 10, fontWeight: 700, whiteSpace: 'nowrap' })
const btn = (bg, col, bd) => ({ ...btnStyle(bg, col, bd), cursor: 'pointer' })

function tsOf(f) { const v = f.startTs ?? f.end_ts; if (!v) return 0; return typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : (v.toMillis?.() ?? 0) }
function fmtDate(f) { const ms = tsOf(f); if (!ms) return '—'; try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z' } catch { return '—' } }
