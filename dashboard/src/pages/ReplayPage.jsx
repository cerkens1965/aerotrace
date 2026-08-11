import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { collection, addDoc, getDocs, getDoc, doc, onSnapshot, query, orderBy, serverTimestamp, where } from 'firebase/firestore'
import { useClub } from '../contexts/ClubContext'
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { db, storage, auth } from '../firebase/config'
import { parseG3XCSV, subsampleFrames, getFrameAtTime } from '../utils/csvParser'
import { deriveFlightType, FLIGHT_TYPES } from '../utils/logbookUtils'
import SixPack from '../components/ui/SixPack'
import ReplayMap from '../components/map/ReplayMap'
import FlightCharts from '../components/replay/FlightCharts'

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  bg:     '#f0f2f8',
  panel:  'rgba(255,255,255,0.97)',
  border: 'rgba(0,0,0,0.08)',
  amber:  '#F5A623',
  amber10:'rgba(245,166,35,0.10)',
  amber20:'rgba(245,166,35,0.20)',
  green:  '#22c55e',
  red:    '#ef4444',
  text:   '#0a0e1e',
  mid:    'rgba(10,14,30,0.5)',
  mono:   'monospace',
}

// ─── Flight phase colors ──────────────────────────────────────────────────────
const PHASE_COLORS = {
  GROUND:   'rgba(255,255,255,0.3)',
  CRUISE:   '#22c55e',
  MANEUVER: '#f97316',
  APPROACH: '#F5A623',
  CRITICAL: '#ef4444',
}

// ─── Format helpers ───────────────────────────────────────────────────────────
function fmtTime(ms) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return `${h > 0 ? h + ':' : ''}${String(m).padStart(2,'0')}:${String(ss).padStart(2,'0')}`
}

function fmtUTC(ts) {
  if (!ts || isNaN(ts)) return ''
  const d = new Date(ts)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const ss = String(d.getUTCSeconds()).padStart(2, '0')
  return `${hh}:${mm}:${ss}Z`
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })
}

// ─── Upload + parse flight CSV ────────────────────────────────────────────────
// Ne crée PAS le doc Firestore — appelle onUploaded avec les données brutes
// L'écriture se fait après assignation pilote/avion dans AssignAfterUpload
function UploadZone({ onUploaded }) {
  const [dragging, setDragging]   = useState(false)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress]   = useState(0)
  const [error, setError]         = useState(null)
  const inputRef = useRef(null)

  const processFile = async (file) => {
    if (!file || !file.name.endsWith('.csv')) return setError('Please select a G3X CSV file')
    setUploading(true); setError(null)
    try {
      const text   = await file.text()
      const parsed = parseG3XCSV(text)
      const path   = `flights/${auth.currentUser.uid}/${Date.now()}_${file.name}`
      const uploadTask = uploadBytesResumable(ref(storage, path), file)
      uploadTask.on('state_changed',
        snap => setProgress(Math.round(snap.bytesTransferred / snap.totalBytes * 100)),
        err  => { setError(err.message); setUploading(false) },
        async () => {
          const url = await getDownloadURL(uploadTask.snapshot.ref)
          onUploaded({ parsed, path, url, fileName: file.name })
          setUploading(false)
        }
      )
    } catch (e) { setError(e.message); setUploading(false) }
  }

  return (
    <div
      onClick={() => inputRef.current?.click()}
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); processFile(e.dataTransfer.files[0]) }}
      style={{
        border: `2px dashed ${dragging ? C.amber : C.border}`,
        borderRadius: 12, padding: '32px 24px', textAlign: 'center',
        cursor: 'pointer', transition: 'all 0.2s',
        background: dragging ? C.amber10 : 'transparent',
      }}
    >
      <input ref={inputRef} type="file" accept=".csv" style={{ display: 'none' }}
        onChange={e => processFile(e.target.files[0])} />

      {uploading ? (
        <div>
          <div style={{ fontFamily: C.mono, fontSize: 11, color: C.amber, marginBottom: 12 }}>
            UPLOADING & PARSING... {progress}%
          </div>
          <div style={{ height: 4, background: C.border, borderRadius: 2 }}>
            <div style={{ height: '100%', width: `${progress}%`, background: C.amber,
              borderRadius: 2, transition: 'width 0.2s' }} />
          </div>
        </div>
      ) : (
        <>
          <div style={{ fontSize: 28, marginBottom: 12 }}>✈</div>
          <div style={{ fontFamily: C.mono, fontSize: 11, color: C.text, marginBottom: 6 }}>
            DROP GARMIN G3X CSV HERE
          </div>
          <div style={{ fontFamily: C.mono, fontSize: 9, color: C.mid }}>
            or click to browse
          </div>
          {error && (
            <div style={{ marginTop: 12, fontFamily: C.mono, fontSize: 10, color: C.red }}>
              ⚠ {error}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Assignation post-upload ──────────────────────────────────────────────────
const RadioBtn = ({ label, active, onClick }) => (
  <button onClick={onClick} type="button" style={{ flex: 1, padding: '4px 0', background: active ? 'rgba(245,166,35,0.15)' : 'rgba(255,255,255,0.03)', border: `1px solid ${active ? 'rgba(245,166,35,0.5)' : 'rgba(255,255,255,0.08)'}`, color: active ? '#F5A623' : 'rgba(255,255,255,0.4)', fontFamily: 'monospace', fontSize: 10, borderRadius: 4, cursor: 'pointer' }}>{label}</button>
)

function AssignAfterUpload({ uploadData, pilots, aircraft, onSaved, onCancel }) {
  const { parsed, path, url, fileName } = uploadData
  const [aircraftIdent,     setAircraftIdent]     = useState(parsed.airframe?.aircraft_ident || '')
  const [pilotId,           setPilotId]           = useState('')
  const [instructorId,      setInstructorId]      = useState('')
  const [instructorOnboard, setInstructorOnboard] = useState(true)
  const [saving,            setSaving]            = useState(false)

  const selectedPilot  = pilots.find(p => p.id === pilotId)
  const isStudent      = selectedPilot?.licence === 'student'
  const pilotRole      = isStudent ? 'student' : 'pilot'
  const instructors    = pilots.filter(p => p.isInstructor === true)
  const flightType     = deriveFlightType(pilotRole, isStudent ? instructorId : null, instructorOnboard)
  const ft             = flightType ? FLIGHT_TYPES[flightType] : null
  const canSave        = aircraftIdent && pilotId && (!isStudent || instructorId)

  const sel = { background: 'rgba(0,0,0,0.04)', border: '1px solid rgba(0,0,0,0.1)', color: '#0a0e1e', fontFamily: 'monospace', fontSize: 11, padding: '5px 8px', borderRadius: 4, width: '100%', outline: 'none', cursor: 'pointer' }
  const lbl = { display: 'block', color: 'rgba(0,0,0,0.45)', fontSize: 9, letterSpacing: 1.2, marginBottom: 4 }

  const handleSave = async () => {
    if (!canSave || saving) return
    setSaving(true)
    try {
      const flightDoc = await addDoc(collection(db, 'flights'), {
        fileName, csvStoragePath: path, csvUrl: url,
        aircraftIdent, pilotId, pilotRole,
        clubId: selectedPilot?.clubId ?? null,
        instructorId:      isStudent ? instructorId      : null,
        instructorOnboard: isStudent ? instructorOnboard : null,
        flightType, validated: true,
        startTs: parsed.stats.startTs, endTs: parsed.stats.endTs,
        duration: parsed.stats.duration, maxAlt: parsed.stats.maxAlt,
        maxSpd: parsed.stats.maxSpd, maxG: parsed.stats.maxG,
        maxRpm: parsed.stats.maxRpm, bounds: parsed.stats.bounds,
        uploadedAt: serverTimestamp(),
      })
      onSaved({ ...parsed, flightId: flightDoc.id })
    } catch (e) { console.error(e) }
    finally { setSaving(false) }
  }

  return (
    <div style={{ padding: '10px 8px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      <div style={{ color: '#F5A623', fontFamily: 'monospace', fontSize: 9, letterSpacing: 1.5, marginBottom: 10 }}>ASSIGNER CE VOL</div>
      <div style={{ marginBottom: 10 }}>
        <span style={lbl}>AÉRONEF</span>
        <select value={aircraftIdent} onChange={e => setAircraftIdent(e.target.value)} style={sel}>
          <option value="">Sélectionner…</option>
          {aircraft.map(a => { const cs = a.callSign || a.registration; return <option key={a.id} value={cs}>{cs} — {a.typeDesig || a.type}</option> })}
        </select>
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={lbl}>PILOTE</span>
        <select value={pilotId} onChange={e => { setPilotId(e.target.value); setInstructorId('') }} style={sel}>
          <option value="">Sélectionner…</option>
          {pilots.map(p => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}{p.trigram ? ` (${p.trigram})` : ''}</option>)}
        </select>
      </div>
      {selectedPilot && (
        <div style={{ color: isStudent ? '#60a5fa' : '#22c55e', fontFamily: 'monospace', fontSize: 10, marginBottom: 10 }}>
          {isStudent ? '🎓 STUDENT — instructor requis' : '✈ PILOT — vol solo'}
        </div>
      )}
      {isStudent && pilotId && (
        <div style={{ background: 'rgba(96,165,250,0.06)', border: '1px solid rgba(96,165,250,0.2)', borderRadius: 6, padding: '8px', marginBottom: 10 }}>
          <div style={{ marginBottom: 8 }}>
            <span style={lbl}>INSTRUCTEUR</span>
            <select value={instructorId} onChange={e => setInstructorId(e.target.value)} style={sel}>
              <option value="">Sélectionner…</option>
              {instructors.map(p => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}{p.trigram ? ` (${p.trigram})` : ''}</option>)}
            </select>
          </div>
          <span style={lbl}>PRÉSENCE</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <RadioBtn label="🪑 À BORD"  active={instructorOnboard === true}  onClick={() => setInstructorOnboard(true)} />
            <RadioBtn label="📡 AU SOL" active={instructorOnboard === false} onClick={() => setInstructorOnboard(false)} />
          </div>
        </div>
      )}
      {ft && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, padding: '4px 8px', background: 'rgba(255,255,255,0.02)', borderRadius: 4 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: ft.color }} />
          <span style={{ color: ft.color, fontFamily: 'monospace', fontSize: 10 }}>{ft.label.toUpperCase()}</span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={onCancel} style={{ flex: 1, padding: '5px 0', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.4)', fontFamily: 'monospace', fontSize: 10, borderRadius: 4, cursor: 'pointer' }}>ANNULER</button>
        <button onClick={handleSave} disabled={!canSave || saving} style={{ flex: 2, padding: '5px 0', background: canSave && !saving ? 'rgba(245,166,35,0.15)' : 'rgba(255,255,255,0.04)', border: `1px solid ${canSave && !saving ? 'rgba(245,166,35,0.4)' : 'rgba(255,255,255,0.06)'}`, color: canSave && !saving ? '#F5A623' : 'rgba(255,255,255,0.2)', fontFamily: 'monospace', fontSize: 10, fontWeight: 700, borderRadius: 4, cursor: canSave && !saving ? 'pointer' : 'not-allowed' }}>
          {saving ? '…' : '✓ VALIDER'}
        </button>
      </div>
    </div>
  )
}

// ─── Flight list item ─────────────────────────────────────────────────────────
function FlightItem({ flight, selected, onSelect }) {
  return (
    <div onClick={() => onSelect(flight)} style={{
      padding: '10px 12px', borderRadius: 8, cursor: 'pointer',
      border: `1px solid ${selected ? C.amber20 : C.border}`,
      background: selected ? C.amber10 : 'rgba(255,255,255,0.02)',
      transition: 'all 0.15s', marginBottom: 4,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontFamily: C.mono, fontSize: 11, fontWeight: 700, color: C.text }}>
          {flight.aircraftIdent}
        </span>
        <span style={{ fontFamily: C.mono, fontSize: 9, color: C.amber }}>
          {fmtTime(flight.duration * 1000)}
        </span>
      </div>
      <div style={{ fontFamily: C.mono, fontSize: 9, color: C.mid, marginBottom: 4 }}>
        {fmtDate(flight.startTs)}
      </div>
      <div style={{ display: 'flex', gap: 12 }}>
        {[
          { l: 'ALT', v: `${flight.maxAlt}ft` },
          { l: 'SPD', v: `${Math.round(flight.maxSpd * 1.852)}km/h` },
          { l: 'G',   v: `${flight.maxG}g` },
        ].map(s => (
          <div key={s.l}>
            <span style={{ fontFamily: C.mono, fontSize: 7, color: C.mid }}>{s.l} </span>
            <span style={{ fontFamily: C.mono, fontSize: 9, color: C.text }}>{s.v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Timeline scrubber ────────────────────────────────────────────────────────
function Timeline({ frames, currentTs, onSeek, playing, onPlayPause, speed, onSpeedChange }) {
  const isDragging = useRef(false)

  if (!frames || frames.length === 0) return null
  const startTs = frames[0].ts
  const endTs   = frames[frames.length-1].ts
  const total   = endTs - startTs
  const progress = ((currentTs - startTs) / total) * 100
  const seek = (e, currentTarget) => {
    const rect = (currentTarget || e.currentTarget).getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    onSeek(startTs + ratio * total)
  }
  const handleMouseDown = (e) => { isDragging.current = true; seek(e) }
  const handleMouseMove = (e) => { if (isDragging.current) seek(e) }
  const handleMouseUp   = ()  => { isDragging.current = false }

  return (
    <div style={{ padding: '12px 16px', background: C.panel, borderTop: `1px solid ${C.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        {/* Play/Pause */}
        <button onClick={onPlayPause} style={{
          width: 32, height: 32, borderRadius: '50%',
          background: C.amber10, border: `1px solid ${C.amber20}`,
          color: C.amber, fontSize: 14, cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          {playing ? '⏸' : '▶'}
        </button>

        {/* Time */}
        <span style={{ fontFamily: C.mono, fontSize: 10, color: C.text, minWidth: 50 }}>
          {fmtTime(currentTs - startTs)}
        </span>
        <span style={{ fontFamily: C.mono, fontSize: 10, color: C.amber, minWidth: 70 }}>
          {fmtUTC(currentTs)}
        </span>

        {/* Speed selector */}
        <div style={{ display: 'flex', gap: 4 }}>
          {[1, 2, 5, 10, 30].map(s => (
            <button key={s} onClick={() => onSpeedChange(s)} style={{
              padding: '2px 7px', borderRadius: 4,
              background: speed === s ? C.amber10 : 'transparent',
              border: `1px solid ${speed === s ? C.amber20 : C.border}`,
              color: speed === s ? C.amber : C.mid,
              fontFamily: C.mono, fontSize: 9, cursor: 'pointer',
            }}>
              {s}x
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />
        <span style={{ fontFamily: C.mono, fontSize: 10, color: C.amber, minWidth: 70, textAlign: 'right' }}>
          {fmtUTC(startTs + total)}
        </span>
        <span style={{ fontFamily: C.mono, fontSize: 10, color: C.mid }}>
          {fmtTime(total)}
        </span>
      </div>

      {/* Progress bar */}
      <div onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} style={{ height: 6, background: C.border, borderRadius: 3, cursor: 'ew-resize', position: 'relative', userSelect: 'none' }}>
        <div style={{
          height: '100%', width: `${progress}%`, background: C.amber,
          borderRadius: 3, transition: playing ? 'none' : 'width 0.05s', position: 'relative',
        }}>
          <div style={{ position: 'absolute', right: -8, top: -5,
            width: 16, height: 16, borderRadius: '50%',
            background: C.amber, border: '2px solid #ffffff',
            boxShadow: 'none',
            pointerEvents: 'none',
          }} />
        </div>
        {/* Phase coloring - mini bars */}
        <div style={{
          position: 'absolute', top: 10, left: 0, right: 0, height: 3,
          display: 'flex',
        }}>
          {subsampleFrames(frames, 500).map((f, i) => {
            const x = ((f.ts - startTs) / total) * 100
            return <div key={i} style={{
              position: 'absolute', left: `${x}%`, width: '0.25%', height: '100%',
              background: PHASE_COLORS[f.phase] ?? C.green,
            }} />
          })}
        </div>
      </div>
    </div>
  )
}

// ─── Data strip ───────────────────────────────────────────────────────────────
function DataStrip({ frame }) {
  if (!frame) return null
  const items = [
    { l: 'GS',    v: `${Math.round(frame.spd * 1.852)}km/h` },
    { l: 'ALT',   v: `${Math.round(frame.alt)}ft` },
    { l: 'AGL',   v: `${Math.round(frame.agl)}ft` },
    { l: 'VSI',   v: `${frame.vspd > 0 ? '+' : ''}${Math.round(frame.vspd)}fpm` },
    { l: 'HDG',   v: `${Math.round(frame.hdg)}°` },
    { l: 'G',     v: `${frame.normAc.toFixed(2)}g`, alert: Math.abs(frame.normAc) > 2 },
    { l: 'RPM',   v: Math.round(frame.rpm) },
    { l: 'OAT',   v: `${Math.round(frame.oat)}°C` },
    { l: 'PHASE', v: frame.phase, color: PHASE_COLORS[frame.phase] },
  ]
  return (
    <div style={{ display: 'flex', gap: 0, background: C.panel,
      borderTop: `1px solid ${C.border}`, padding: '8px 16px', flexWrap: 'wrap', gap: 20 }}>
      {items.map(item => (
        <div key={item.l}>
          <div style={{ fontFamily: C.mono, fontSize: 7, color: C.mid, letterSpacing: '0.08em' }}>{item.l}</div>
          <div style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 700,
            color: item.alert ? C.red : (item.color ?? C.text) }}>
            {item.v}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Main REPLAY page ─────────────────────────────────────────────────────────
export default function ReplayPage({ user }) {
  const { flightId }  = useParams()
  const { clubId }    = useClub()
  const [flights,      setFlights]      = useState([])
  const [selected,     setSelected]     = useState(null)
  const [parsed,       setParsed]       = useState(null)
  const [currentTs,    setCurrentTs]    = useState(0)
  const [playing,      setPlaying]      = useState(false)
  const [speed,        setSpeed]        = useState(1)
  const [showUpload,   setShowUpload]   = useState(false)
  const [pendingUpload, setPendingUpload] = useState(null)
  const [pilots,       setPilots]       = useState([])
  const [aircraft,     setAircraft]     = useState([])
  const [sideOpen,     setSideOpen]     = useState(true)
  const [is3D,         setIs3D]         = useState(false)
  const animRef     = useRef(null)
  const lastTimeRef = useRef(null)
  const csvAbortRef = useRef(null)   // annule le fetch CSV précédent si l'user change de vol

  const loadCSV = useCallback(async (fl) => {
    csvAbortRef.current?.abort()
    csvAbortRef.current = new AbortController()
    const { signal } = csvAbortRef.current
    setSelected(fl)
    setParsed(null)
    // Les vols uploadés par boîtier n'ont pas de csvUrl (seulement csvStoragePath) :
    // on reconstruit l'URL de download à la volée depuis Storage. GCS sert le CSV
    // décompressé (transcoding gzip) → parseG3XCSV inchangé.
    let url = fl.csvUrl
    if (!url && fl.csvStoragePath) {
      try { url = await getDownloadURL(ref(storage, fl.csvStoragePath)) }
      catch (e) { console.error('CSV URL from storage path:', e); return }
    }
    if (!url) return
    try {
      const res  = await fetch(url, { signal })
      const text = await res.text()
      const p    = parseG3XCSV(text)
      setParsed(p)
      setCurrentTs(p.frames[0].ts)
      setPlaying(false)
    } catch (e) {
      if (e.name !== 'AbortError') console.error('Load CSV:', e)
    }
  }, [])

  // ── Charger les vols du club courant ─────────────────────────────────────
  // Note : firmware ESP32 écrit `club_id` (snake_case), dashboard écrit
  // `clubId` (camelCase). On filtre sur `clubId` ici ; les vols legacy
  // sans ce champ ne s'afficheront pas tant qu'ils ne sont pas backfillés.
  // orderBy retiré (tri client-side) pour ne pas dépendre d'index composite.
  useEffect(() => {
    if (!clubId) { setFlights([]); return }
    const q = query(collection(db, 'flights'), where('clubId', '==', clubId))
    return onSnapshot(q, snap => {
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      docs.sort((a, b) => (b.startTs || 0) - (a.startTs || 0))
      setFlights(docs)
    })
  }, [clubId])

  // ── Charger pilots + aircraft du club courant pour AssignAfterUpload ─────
  useEffect(() => {
    if (!clubId) { setPilots([]); setAircraft([]); return }
    async function load() {
      const [ps, as] = await Promise.all([
        getDocs(query(collection(db, 'pilots'),   where('clubId', '==', clubId))),
        getDocs(query(collection(db, 'aircraft'), where('clubId', '==', clubId))),
      ])
      setPilots(ps.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.archived !== true))
      setAircraft(as.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => a.archived !== true))
    }
    load()
  }, [clubId])

  // ── Auto-load depuis URL /replay/:flightId (vient du Logbook) ─────────────
  useEffect(() => {
    if (!flightId) return
    async function autoLoad() {
      try {
        const snap = await getDoc(doc(db, 'flights', flightId))
        if (!snap.exists()) return
        loadCSV({ id: snap.id, ...snap.data() })
      } catch (e) { console.error('Auto-load flight:', e) }
    }
    autoLoad()
  }, [flightId, loadCSV])

  // Playback loop
  useEffect(() => {
    if (!playing || !parsed) return
    const frames = parsed.frames
    const endTs = frames[frames.length-1].ts

    const tick = (now) => {
      if (lastTimeRef.current === null) lastTimeRef.current = now
      const dt = (now - lastTimeRef.current) * speed
      lastTimeRef.current = now
      setCurrentTs(prev => {
        const next = prev + dt
        if (next >= endTs) { setPlaying(false); return endTs }
        return next
      })
      animRef.current = requestAnimationFrame(tick)
    }
    animRef.current = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(animRef.current); lastTimeRef.current = null }
  }, [playing, speed, parsed])

  const handlePlayPause = () => { lastTimeRef.current = null; setPlaying(p => !p) }
  const handleSeek = (ts) => { lastTimeRef.current = null; setCurrentTs(ts); setPlaying(false) }
  const handleUploaded = (data) => { setPendingUpload(data); setShowUpload(false) }
  const handleSaved = (data) => { setParsed(data); setCurrentTs(data.frames[0].ts); setPlaying(false); setPendingUpload(null) }

  const currentFrame = parsed ? getFrameAtTime(parsed.frames, currentTs) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, overflow: 'hidden' }}>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── Sidebar ── */}
        <div style={{
          width: sideOpen ? 220 : 36, flexShrink: 0, transition: 'width 0.2s',
          borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column',
          background: C.panel, overflow: 'hidden',
        }}>
          {/* Toggle */}
          <div onClick={() => setSideOpen(p => !p)} style={{
            padding: '8px 10px', cursor: 'pointer', display: 'flex',
            alignItems: 'center', gap: 8, borderBottom: `1px solid ${C.border}`,
          }}>
            <span style={{ fontSize: 10, color: C.amber, transform: sideOpen ? 'none' : 'rotate(180deg)', transition: 'transform 0.2s' }}>◀</span>
            {sideOpen && <span style={{ fontFamily: C.mono, fontSize: 9, color: C.text, letterSpacing: '0.1em' }}>FLIGHTS</span>}
          </div>

          {sideOpen && (
            <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
              {/* Upload button */}
              <button onClick={() => setShowUpload(p => !p)} style={{
                width: '100%', padding: '6px 10px', marginBottom: 10,
                background: C.amber10, border: `1px solid ${C.amber20}`,
                borderRadius: 6, color: C.amber, fontFamily: C.mono,
                fontSize: 9, fontWeight: 700, cursor: 'pointer', letterSpacing: '0.08em',
              }}>
                + IMPORT CSV
              </button>

              {showUpload && (
                <div style={{ marginBottom: 12 }}>
                  <UploadZone onUploaded={handleUploaded} />
                </div>
              )}

              {pendingUpload && (
                <AssignAfterUpload
                  uploadData={pendingUpload}
                  pilots={pilots}
                  aircraft={aircraft}
                  onSaved={handleSaved}
                  onCancel={() => setPendingUpload(null)}
                />
              )}

              {/* Flight list */}
              {flights.length === 0 && !showUpload && !pendingUpload && (
                <div style={{ fontFamily: C.mono, fontSize: 9, color: C.mid, textAlign: 'center', padding: 16 }}>
                  No flights yet.<br/>Import a G3X CSV.
                </div>
              )}
              {flights.map(f => (
                <FlightItem key={f.id} flight={f} selected={selected?.id === f.id}
                  onSelect={loadCSV}
                />
              ))}
            </div>
          )}
        </div>

        {/* ── Main content ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {!parsed ? (
            /* Empty state */
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexDirection: 'column', gap: 16 }}>
              <div style={{ fontSize: 32 }}>▶</div>
              <div style={{ fontFamily: C.mono, fontSize: 12, color: C.text }}>SELECT A FLIGHT OR IMPORT CSV</div>
              <div style={{ fontFamily: C.mono, fontSize: 9, color: C.mid }}>
                Garmin G3X format supported
              </div>
            </div>
          ) : (
            <>
              {/* Map + six-pack */}
              <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                {/* MapLibre map */}
                <div style={{ flex: 1, position: 'relative' }}>
                  <ReplayMap frames={parsed.frames} currentFrame={currentFrame} is3D={is3D} isPlaying={playing} speed={speed} />

                  {/* ── Bouton 2D / 3D ── */}
                  <button
                    onClick={() => setIs3D(v => !v)}
                    style={{
                      position:      'absolute',
                      top:           10,
                      left:          '50%',
                      transform:     'translateX(-50%)',
                      zIndex:        20,
                      background:    is3D ? C.amber : 'rgba(255,255,255,0.92)',
                      color:         is3D ? '#050814' : C.text,
                      border:        `1px solid ${is3D ? C.amber : 'rgba(0,0,0,0.15)'}`,
                      borderRadius:  6,
                      padding:       '4px 16px',
                      fontFamily:    C.mono,
                      fontSize:      10,
                      fontWeight:    700,
                      letterSpacing: '0.12em',
                      cursor:        'pointer',
                      userSelect:    'none',
                    }}
                  >
                    {is3D ? '3D' : '2D'}
                  </button>
                </div>

                {/* Six-pack */}
                <div style={{ width: 300, padding: '8px', display: 'flex', alignItems: 'center',
                  borderLeft: '1px solid rgba(0,0,0,0.08)', background: 'rgba(255,255,255,0.97)' }}>
                  <SixPack frame={currentFrame} size={110} />
                </div>
              </div>

              {/* Data strip */}
              <DataStrip frame={currentFrame} />

              {/* Flight charts */}
              <FlightCharts frames={parsed.frames} currentTs={currentTs} height={130} onSeek={handleSeek} />
            </>
          )}

          {/* Timeline */}
          <Timeline
            frames={parsed?.frames}
            currentTs={currentTs}
            onSeek={handleSeek}
            playing={playing}
            onPlayPause={handlePlayPause}
            speed={speed}
            onSpeedChange={setSpeed}
          />
        </div>
      </div>

      <style>{`
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
      `}</style>
    </div>
  )
}
