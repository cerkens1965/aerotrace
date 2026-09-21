import { useState, useEffect, useRef } from 'react'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { ref as storageRef, getDownloadURL, uploadBytes } from 'firebase/storage'
import { db, storage } from '../firebase/config'
import { useClub } from '../contexts/ClubContext'
import { T, labelStyle, headingStyle, monoStyle, Button, MetricCard, DataTable, Tabs, EmptyState, Banner, StatusDot } from '../components/ui'

// ─── DevPage — outils dev (admin + super_admin) ──────────────────────────────
// Trois onglets :
//  1. LTE DASHBOARD — le VRAI moniteur LTE (public/tools/lte-monitor/) en iframe
//     plein écran. Charge un ATCORE_LTE_*.csv via son bouton « LOAD SD ».
//  2. SIMULATOR — le VRAI simulateur d'alertes (public/tools/altsim/) en iframe.
//     Charge un CSV de vol via son propre sélecteur de fichier.
//  3. QUICK-CHECK — l'outil léger d'origine : liste des vols du club, check LTE
//     express (couverture/signal/opérateurs + tracé), upload/téléchargement des
//     CSV LTE (flights_lte/<fid>.csv) et export du CSV vol (chargeable dans le simu).
// Les iframes restent MONTÉES (display toggle) → l'outil et le fichier chargé
// sont préservés quand on change d'onglet. Phase 2 (à venir) : auto-injecter le
// CSV d'un vol sélectionné dans l'outil via postMessage.

// (2026-09-21, lot 02 B) Restylé AirKi : tokens T, Tabs, Button, MetricCard, DataTable, Banner, EmptyState.
// Pas de rouge : signal faible / pas de service = blanc sur encre, qualité moyenne = ambre, bonne = vert.

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
        iCsq = ci('csq_rssi'), iFix = ci('fix_ok')
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

// Couleurs du tracé (sur encre) : bon = vert, moyen = ambre, faible / pas de service = blanc, n/a = graphite.
const ROUTE = { good: T.ok, mid: T.amber, weak: T.white, na: T.graphite }

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
      ctx.fillStyle = !p.svc ? ROUTE.weak : p.csq < 0 ? ROUTE.na : p.csq >= 18 ? ROUTE.good : p.csq >= 10 ? ROUTE.mid : ROUTE.weak
      ctx.fillRect(px(p) - 1, py(p) - 1, 2.4, 2.4)
    }
  }, [pts])
  return <canvas ref={ref} width={520} height={230} style={{ width: '100%', maxWidth: 520, background: T.ink, border: T.borderDark, borderRadius: T.radius.md, display: 'block' }} />
}

function Swatch({ color, text }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...monoStyle(11, T.graphite) }}>
      <span aria-hidden="true" style={{ width: 10, height: 10, background: color, border: T.borderDark, borderRadius: 2 }} />
      {text}
    </span>
  )
}

// Bouton d'upload : un <input type=file> caché par ligne (ref locale).
function UploadButton({ onFile }) {
  const ref = useRef(null)
  return (
    <>
      <Button size="sm" variant="ghost" icon="upload" onClick={() => ref.current?.click()}>Upload LTE</Button>
      <input type="file" accept=".csv" ref={ref} style={{ display: 'none' }}
        onChange={e => { onFile(e.target.files[0]); e.target.value = '' }} />
    </>
  )
}

const FRAME = { width: '100%', height: '100%', border: 'none', display: 'block' }

const TABS = [
  { key: 'lte', label: 'LTE dashboard' },
  { key: 'sim', label: 'Simulator' },
  { key: 'check', label: 'Quick-check' },
]

export default function DevPage() {
  const { clubId } = useClub()
  const [tab, setTab] = useState('lte')     // 'lte' | 'sim' | 'check'
  const [flights, setFlights] = useState([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState(null)      // flight sélectionné
  const [lte, setLte] = useState(null)      // stats LTE parsées
  const [busy, setBusy] = useState('')      // message d'état
  const lteFrameRef = useRef(null)          // iframe LTE Dashboard (même origine → postMessage)

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
    } catch (e) { setBusy(e.code === 'storage/object-not-found' ? 'File not found on the server.' : e.message) }
  }

  // Analyse LTE : récupère flights_lte/<fid>.csv → parse → stats.
  const analyzeLte = async (f) => {
    setSel(f); setLte(null); setBusy('Loading LTE…')
    try {
      const url = await getDownloadURL(storageRef(storage, `flights_lte/${fidOf(f)}.csv`))
      const txt = await (await fetch(url)).text()
      setLte(parseLte(txt)); setBusy('')
    } catch (e) {
      setBusy(e.code === 'storage/object-not-found' ? 'No LTE file for this flight — upload it first.' : e.message)
    }
  }

  const uploadLte = async (f, file) => {
    if (!file) return
    setSel(f); setBusy('Uploading LTE…')
    try {
      await uploadBytes(storageRef(storage, `flights_lte/${fidOf(f)}.csv`), file, { contentType: 'text/csv' })
      setBusy('Upload done — analysing…')
      const txt = await file.text(); setLte(parseLte(txt)); setBusy('')
    } catch (e) { setBusy(e.message) }
  }

  // Balance le CSV LTE d'un vol vers le LTE Dashboard (iframe même origine) pour étude approfondie.
  const studyLte = async (f) => {
    setBusy('Sending LTE to the dashboard…')
    try {
      const url = await getDownloadURL(storageRef(storage, `flights_lte/${fidOf(f)}.csv`))
      const txt = await (await fetch(url)).text()
      setBusy(''); setTab('lte')
      // l'iframe reste montée (display toggle) → déjà chargée & à l'écoute ; petit délai de sûreté.
      setTimeout(() => lteFrameRef.current?.contentWindow?.postMessage(
        { type: 'aerotrace-lte-csv', name: `${fidOf(f)}.csv`, text: txt }, window.location.origin), 80)
    } catch (e) {
      setBusy(e.code === 'storage/object-not-found' ? 'No LTE file for this flight — upload it first.' : e.message)
    }
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: T.paper, color: T.ink, fontFamily: T.sans }}>
      {/* Barre d'onglets */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: '10px 16px', borderBottom: T.border, background: T.paper }}>
        <h1 style={{ ...headingStyle(18), margin: 0 }}>Dev</h1>
        <Tabs tabs={TABS} value={tab} onChange={setTab} ariaLabel="Dev tools" />
        <span style={{ ...labelStyle(T.etch), marginLeft: 'auto' }}>ADMIN</span>
      </div>

      {/* Contenu — les 2 iframes restent montées (display toggle) pour préserver l'état */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 0, display: tab === 'lte' ? 'block' : 'none' }}>
          <iframe ref={lteFrameRef} title="LTE Dashboard" src="/tools/lte-monitor/index.html" style={FRAME} />
        </div>
        <div style={{ position: 'absolute', inset: 0, display: tab === 'sim' ? 'block' : 'none' }}>
          <iframe title="Alert Simulator" src="/tools/altsim/index.html" style={FRAME} />
        </div>
        {tab === 'check' && (
          <div style={{ position: 'absolute', inset: 0, overflowY: 'auto', padding: '24px' }}>
            <QuickCheck
              loading={loading} clubId={clubId} flights={flights} sel={sel} lte={lte} busy={busy}
              fidOf={fidOf} download={download} analyzeLte={analyzeLte} uploadLte={uploadLte} studyLte={studyLte}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// ─── QUICK-CHECK — l'outil léger d'origine (liste vols + check LTE express) ────
function QuickCheck({ loading, clubId, flights, sel, lte, busy, fidOf, download, analyzeLte, uploadLte, studyLte }) {
  // Message d'état : « …» final = en cours (info), sinon erreur récupérable (caution).
  const busyTone = busy.endsWith('…') ? 'info' : 'caution'
  const toneOf = (v, good, mid) => v >= good ? 'ok' : v >= mid ? 'caution' : 'off'

  const columns = [
    {
      key: 'flight', label: 'FLIGHT',
      render: (f) => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {sel?.id === f.id && <StatusDot tone="caution" />}
          <div>
            <div style={{ fontWeight: 600 }}>{f.aircraftIdent || f.aircraft_ident || '—'}</div>
            <div style={{ ...monoStyle(11, T.graphite), marginTop: 2 }}>{fidOf(f)}</div>
          </div>
        </div>
      ),
    },
    { key: 'date', label: 'DATE (UTC)', mono: true, render: (f) => <span style={{ whiteSpace: 'nowrap' }}>{fmtDate(f)}</span> },
    { key: 'route', label: 'ROUTE', mono: true, render: (f) => <span style={{ whiteSpace: 'nowrap' }}>{f.depIcao || '?'} → {f.arrIcao || '?'}</span> },
    { key: 'dur', label: 'DURATION', mono: true, align: 'right', render: (f) => (f.duration ? Math.round(f.duration / 60) + ' min' : '—') },
    {
      key: 'actions', label: '', align: 'right',
      render: (f) => (
        <div style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Button size="sm" variant="primary" icon="download" title="Download the flight CSV (loadable in the simulator)"
            onClick={() => download(`flights/${fidOf(f)}.csv`, `${fidOf(f)}.csv`)}>CSV for simulator</Button>
          <Button size="sm" onClick={() => analyzeLte(f)}>Check LTE</Button>
          <Button size="sm" iconRight="external" title="Load this flight in the LTE dashboard (in-depth study)"
            onClick={() => studyLte(f)}>LTE dashboard</Button>
          <UploadButton onFile={(file) => uploadLte(f, file)} />
        </div>
      ),
    },
  ]

  return (
    <div style={{ maxWidth: 1040, margin: '0 auto' }}>
      <h2 style={{ ...headingStyle(20), margin: 0 }}>Quick-check · LTE</h2>
      <p style={{ fontSize: 14, lineHeight: 1.5, color: T.graphite, margin: '6px 0 0', maxWidth: 720 }}>
        Check a flight's LTE capture (coverage, signal, operators), upload the LTE file to the server,
        and fetch the flight CSV to load it in the simulator (Simulator tab).
      </p>

      {busy && <Banner tone={busyTone} style={{ marginTop: 14 }}>{busy}</Banner>}

      {/* Panneau d'analyse LTE */}
      {sel && lte && (
        <div style={{ background: T.card, border: T.border, borderRadius: T.radius.md, padding: 16, marginTop: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
            <h3 style={{ ...headingStyle(16), margin: 0 }}>LTE · {sel.aircraftIdent || sel.aircraft_ident || fidOf(sel)}</h3>
            <span style={monoStyle(12, T.graphite)}>{fidOf(sel)}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
            <MetricCard label="LTE COVERAGE" value={lte.svcPct} unit="%" status={{ tone: toneOf(lte.svcPct, 70, 40), text: lte.svcPct >= 70 ? 'good' : lte.svcPct >= 40 ? 'partial' : 'poor' }} />
            <MetricCard label="GPS FIX" value={lte.fixPct} unit="%" status={{ tone: lte.fixPct >= 90 ? 'ok' : 'caution', text: lte.fixPct >= 90 ? 'good' : 'partial' }} />
            <MetricCard label="MEDIAN CSQ" value={lte.csqMed} status={{ tone: toneOf(lte.csqMed, 18, 10), text: lte.csqMed >= 18 ? 'good' : lte.csqMed >= 10 ? 'fair' : 'weak' }} />
            <MetricCard label="SAMPLES" value={lte.tot} />
          </div>
          <RouteCanvas pts={lte.pts} />
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10 }}>
            <Swatch color={ROUTE.good} text="csq ≥ 18" />
            <Swatch color={ROUTE.mid} text="10–17" />
            <Swatch color={ROUTE.weak} text="weak / no service" />
            <Swatch color={ROUTE.na} text="csq n/a" />
          </div>
          <div style={{ marginTop: 12, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span style={labelStyle(T.etch)}>OPERATORS</span>
            {lte.ops.map(([op, n]) => (
              <span key={op} style={monoStyle(12)}>{op} <span style={{ fontWeight: 600 }}>{Math.round(100 * n / lte.tot)}%</span></span>
            ))}
          </div>
        </div>
      )}

      {/* Liste des vols */}
      <div style={{ marginTop: 14 }}>
        {!loading && !clubId ? (
          <div style={{ background: T.card, border: T.border, borderRadius: T.radius.md }}>
            <EmptyState text="Select a club first." />
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={flights}
            loading={loading}
            empty={<EmptyState text="No flights for this club." />}
          />
        )}
      </div>
    </div>
  )
}

function tsOf(f) { const v = f.startTs ?? f.end_ts; if (!v) return 0; return typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : (v.toMillis?.() ?? 0) }
function fmtDate(f) { const ms = tsOf(f); if (!ms) return '—'; try { return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z' } catch { return '—' } }
