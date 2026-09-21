import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { collection, getDoc, doc, onSnapshot, query, where } from 'firebase/firestore'
import { useClub } from '../contexts/ClubContext'
import { ref, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../firebase/config'
import { parseG3XCSV, subsampleFrames, getFrameAtTime } from '../utils/csvParser'
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
// Loop = relecture seule. L'import CSV et l'attribution pilote/avion vivent dans le Logbook.
export default function ReplayPage({ role }) {
  const { flightId }  = useParams()
  const navigate      = useNavigate()
  const canLogbook    = role === 'instructor' || role === 'admin' || role === 'super_admin'
  const { clubId }    = useClub()
  const [flights,      setFlights]      = useState([])
  const [selected,     setSelected]     = useState(null)
  const [parsed,       setParsed]       = useState(null)
  const [currentTs,    setCurrentTs]    = useState(0)
  const [playing,      setPlaying]      = useState(false)
  const [speed,        setSpeed]        = useState(1)
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
      const docs = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(f => f.archived !== true)   // soft-delete : archivés masqués
      docs.sort((a, b) => (b.startTs || 0) - (a.startTs || 0))
      setFlights(docs)
    })
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

  const currentFrame = parsed ? getFrameAtTime(parsed.frames, currentTs) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, overflow: 'hidden' }}>

      {/* Titre de page — « Loop » : texte seul, Semibold, encre (règle de marque 10) */}
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.panel, flexShrink: 0 }}>
        <h1 style={{ margin: 0, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 18, letterSpacing: '-0.02em', color: 'var(--ink)' }}>Loop</h1>
      </div>

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
              {/* Import / attribution : dans le Logbook */}
              {canLogbook && (
                <button onClick={() => navigate('/logbook', { state: selected ? { flightId: selected.id } : null })} style={{
                  width: '100%', padding: '6px 10px', marginBottom: 10,
                  background: C.amber10, border: `1px solid ${C.amber20}`,
                  borderRadius: 6, color: C.amber, fontFamily: C.mono,
                  fontSize: 9, fontWeight: 700, cursor: 'pointer', letterSpacing: '0.08em',
                }}>
                  Open in logbook
                </button>
              )}

              {/* Flight list */}
              {flights.length === 0 && (
                <div style={{ fontFamily: C.mono, fontSize: 9, color: C.mid, textAlign: 'center', padding: 16 }}>
                  No flights yet.{canLogbook && <><br/>Import flights from the logbook.</>}
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
              <div style={{ fontFamily: C.mono, fontSize: 12, color: C.text }}>SELECT A FLIGHT TO REPLAY</div>
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
