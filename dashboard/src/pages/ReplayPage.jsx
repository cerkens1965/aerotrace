import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { getDoc, doc } from 'firebase/firestore'
import { ref, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../firebase/config'
import { parseG3XCSV, subsampleFrames, getFrameAtTime } from '../utils/csvParser'
import SixPack from '../components/ui/SixPack'
import ReplayMap from '../components/map/ReplayMap'
import FlightCharts from '../components/replay/FlightCharts'
import { formatDateTime, formatDuration } from '../utils/logbookUtils'

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

// ─── Flight identity (barre du haut) ─────────────────────────────────────────
// Immat · date · pilote (si fiche lisible) · durée. Le pilote est lu à part : un échec
// (fiche supprimée, droits) n'empêche pas la lecture du vol.
function FlightIdentity({ flight, pilotName }) {
  if (!flight) return null
  const items = [
    flight.aircraftIdent || '—',
    formatDateTime(flight.startTs),
    pilotName,
    flight.duration ? formatDuration(flight.duration) : null,
  ].filter(Boolean)
  return (
    <span style={{ fontFamily: C.mono, fontSize: 11, color: C.mid, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      {items.join(' · ')}
    </span>
  )
}

// Bouton neutre du lecteur (retour Logbook, états vides).
const NAV_BTN = {
  padding: '5px 12px', borderRadius: 6, cursor: 'pointer',
  background: 'transparent', border: `1px solid ${C.border}`,
  color: C.text, fontFamily: C.mono, fontSize: 10, whiteSpace: 'nowrap',
}

// ─── Main REPLAY page ─────────────────────────────────────────────────────────
// Loop = lecteur d'UN vol, désigné uniquement par l'URL /replay/:flightId. La liste des
// vols, l'import CSV et l'attribution vivent dans le Logbook.
export default function ReplayPage() {
  const { flightId }  = useParams()
  const navigate      = useNavigate()
  const location      = useLocation()
  const [selected,     setSelected]     = useState(null)
  const [pilot,        setPilot]        = useState({ flightId: null, name: null })
  // Résultat du chargement, rattaché au flightId concerné : le statut affiché en est
  // DÉRIVÉ (pas de reset synchrone dans l'effet). 'ready' | 'notfound' | 'error'.
  const [result,       setResult]       = useState({ flightId: null, status: null })
  const [parsed,       setParsed]       = useState(null)
  const [currentTs,    setCurrentTs]    = useState(0)
  const [playing,      setPlaying]      = useState(false)
  const [speed,        setSpeed]        = useState(1)
  const [is3D,         setIs3D]         = useState(false)
  const animRef     = useRef(null)
  const lastTimeRef = useRef(null)
  const csvAbortRef = useRef(null)   // annule le fetch CSV précédent si le vol change

  // Retour au Logbook, sur l'onglet d'où le vol a été ouvert.
  const backToLogbook = () =>
    navigate(location.state?.from || '/logbook', { state: { tab: location.state?.tab } })

  const status = !flightId ? 'none'
    : result.flightId === flightId ? result.status
    : 'loading'
  const view      = status === 'ready' ? parsed : null            // jamais le vol précédent
  const shown     = selected?.id === flightId ? selected : null
  const pilotName = pilot.flightId === flightId ? pilot.name : null

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
      catch (e) { console.error('CSV URL from storage path:', e); setResult({ flightId: fl.id, status: 'error' }); return }
    }
    if (!url) { setResult({ flightId: fl.id, status: 'error' }); return }
    try {
      const res  = await fetch(url, { signal })
      const text = await res.text()
      const p    = parseG3XCSV(text)
      setParsed(p)
      setCurrentTs(p.frames[0].ts)
      setPlaying(false)
      setResult({ flightId: fl.id, status: 'ready' })
    } catch (e) {
      if (e.name !== 'AbortError') { console.error('Load CSV:', e); setResult({ flightId: fl.id, status: 'error' }) }
    }
  }, [])

  // ── Chargement du vol depuis l'URL /replay/:flightId ──────────────────────
  // Introuvable ou archivé (soft delete) → « Flight not found ».
  useEffect(() => {
    if (!flightId) return
    let cancelled = false
    async function autoLoad() {
      try {
        const snap = await getDoc(doc(db, 'flights', flightId))
        if (cancelled) return
        if (!snap.exists() || snap.data().archived === true) { setResult({ flightId, status: 'notfound' }); return }
        const fl = { id: snap.id, ...snap.data() }
        loadCSV(fl)
        if (fl.pilotId) {
          getDoc(doc(db, 'pilots', fl.pilotId))
            .then(p => {
              if (cancelled || !p.exists()) return
              const d = p.data()
              setPilot({ flightId, name: [d.firstName, d.lastName].filter(Boolean).join(' ') || null })
            })
            .catch(e => console.warn('Pilot name:', e))
        }
      } catch (e) {
        console.error('Auto-load flight:', e)
        if (!cancelled) setResult({ flightId, status: 'error' })
      }
    }
    autoLoad()
    return () => { cancelled = true; csvAbortRef.current?.abort() }
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

  const currentFrame = view ? getFrameAtTime(view.frames, currentTs) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, overflow: 'hidden' }}>

      {/* Titre de page — « Loop » : texte seul, Semibold, encre (règle de marque 10) */}
      <div style={{ padding: '10px 16px', borderBottom: `1px solid ${C.border}`, background: C.panel, flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
        {flightId && <button onClick={backToLogbook} style={NAV_BTN}>← Back to logbook</button>}
        <h1 style={{ margin: 0, fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 18, letterSpacing: '-0.02em', color: 'var(--ink)' }}>Loop</h1>
        <FlightIdentity flight={shown} pilotName={pilotName} />
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── Main content ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {!view ? (
            /* États vides : pas de vol dans l'URL / introuvable / illisible / chargement */
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexDirection: 'column', gap: 16 }}>
              {status === 'none' && <>
                <div style={{ fontFamily: C.mono, fontSize: 12, color: C.text }}>Choose a flight in the logbook</div>
                <button onClick={() => navigate('/logbook')} style={NAV_BTN}>Open logbook</button>
              </>}
              {status === 'notfound' && <>
                <div style={{ fontFamily: C.mono, fontSize: 12, color: C.text }}>Flight not found</div>
                <div style={{ fontFamily: C.mono, fontSize: 9, color: C.mid }}>It may have been removed from the logbook.</div>
                <button onClick={backToLogbook} style={NAV_BTN}>Back to logbook</button>
              </>}
              {status === 'error' && <>
                <div style={{ fontFamily: C.mono, fontSize: 12, color: C.text }}>This flight could not be loaded</div>
                <div style={{ fontFamily: C.mono, fontSize: 9, color: C.mid }}>The recording file is missing or unreadable.</div>
                <button onClick={backToLogbook} style={NAV_BTN}>Back to logbook</button>
              </>}
              {(status === 'loading' || status === 'ready') && (
                <div style={{ fontFamily: C.mono, fontSize: 12, color: C.mid }}>Loading flight…</div>
              )}
            </div>
          ) : (
            <>
              {/* Map + six-pack */}
              <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
                {/* MapLibre map */}
                <div style={{ flex: 1, position: 'relative' }}>
                  <ReplayMap frames={view.frames} currentFrame={currentFrame} is3D={is3D} isPlaying={playing} speed={speed} />

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
              <FlightCharts frames={view.frames} currentTs={currentTs} height={130} onSeek={handleSeek} />
            </>
          )}

          {/* Timeline */}
          <Timeline
            frames={view?.frames}
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
