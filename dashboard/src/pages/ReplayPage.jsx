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
import { T, labelStyle, monoStyle, headingStyle, Button, Icon, Banner, EmptyState, Skeleton } from '../components/ui'

// ─── Flight phase colors ──────────────────────────────────────────────────────
// Palette DS : jamais de rouge ; couleur portée par des marques (barres, points), jamais par le texte.
const PHASE_COLORS = {
  GROUND:   T.rule,
  CRUISE:   T.ok,
  MANEUVER: T.info,
  APPROACH: T.amber,
  CRITICAL: T.ink,
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
    <div style={{ padding: '12px 16px', background: T.card, borderTop: T.border }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        {/* Play/Pause */}
        <Button variant="primary" size="sm" onClick={onPlayPause} aria-label={playing ? 'Pause' : 'Play'}
          style={{ width: 32, height: 32, padding: 0 }}>
          {playing
            ? <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" style={{ display: 'block' }}>
                <rect x={6} y={4} width={4} height={16} fill="currentColor" /><rect x={14} y={4} width={4} height={16} fill="currentColor" />
              </svg>
            : <Icon name="play" size={16} />}
        </Button>

        {/* Time */}
        <span style={{ ...monoStyle(12, T.ink), fontWeight: 500, minWidth: 50 }}>
          {fmtTime(currentTs - startTs)}
        </span>
        <span style={{ ...monoStyle(11, T.graphite), minWidth: 70 }}>
          {fmtUTC(currentTs)}
        </span>

        {/* Speed selector */}
        <div style={{ display: 'flex', gap: 4 }}>
          {[1, 2, 5, 10, 30].map(s => (
            <button key={s} onClick={() => onSpeedChange(s)} className="ak-focus" aria-pressed={speed === s} style={{
              padding: '2px 7px', borderRadius: T.radius.sm,
              background: speed === s ? T.ink : T.card,
              border: `1px solid ${speed === s ? T.ink : T.rule}`,
              color: speed === s ? T.white : T.graphite,
              fontFamily: T.mono, fontSize: 11, fontVariantNumeric: 'tabular-nums', cursor: 'pointer',
            }}>
              {s}x
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />
        <span style={{ ...monoStyle(11, T.graphite), minWidth: 70, textAlign: 'right' }}>
          {fmtUTC(startTs + total)}
        </span>
        <span style={{ ...monoStyle(11, T.etch) }}>
          {fmtTime(total)}
        </span>
      </div>

      {/* Progress bar */}
      <div onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp} style={{ height: 6, background: T.rule, borderRadius: 3, cursor: 'ew-resize', position: 'relative', userSelect: 'none' }}>
        <div style={{
          height: '100%', width: `${progress}%`, background: T.amber,
          borderRadius: 3, transition: playing ? 'none' : 'width 0.05s', position: 'relative',
        }}>
          <div style={{ position: 'absolute', right: -8, top: -5,
            width: 16, height: 16, borderRadius: '50%',
            background: T.amber, border: `2px solid ${T.white}`,
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
              background: PHASE_COLORS[f.phase] ?? T.ok,
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
  // Couleur (alerte G, phase) portée par un point 6 px, le texte reste encre.
  return (
    <div style={{ display: 'flex', background: T.card,
      borderTop: T.border, padding: '8px 16px', flexWrap: 'wrap', gap: 20 }}>
      {items.map(item => {
        const dot = item.alert ? T.amber : item.color
        return (
          <div key={item.l}>
            <div style={labelStyle(T.etch)}>{item.l}</div>
            <div style={{ ...monoStyle(12, T.ink), fontWeight: 500, display: 'flex', alignItems: 'center', gap: 5, marginTop: 2 }}>
              {dot && <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: T.radius.pill, background: dot, flexShrink: 0 }} />}
              {item.v}
            </div>
          </div>
        )
      })}
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
    <span style={{ ...monoStyle(12, T.graphite), minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      {items.join(' · ')}
    </span>
  )
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: T.paper, fontFamily: T.sans, color: T.ink, overflow: 'hidden' }}>

      {/* Titre de page — « Loop » : texte seul, Semibold, encre (règle de marque 10) */}
      <div style={{ padding: '10px 16px', borderBottom: T.border, background: T.card, flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
        {flightId && <Button variant="ghost" size="sm" icon="back" onClick={backToLogbook}>Back to logbook</Button>}
        <h1 style={{ ...headingStyle(18, T.ink), margin: 0 }}>Loop</h1>
        <FlightIdentity flight={shown} pilotName={pilotName} />
      </div>

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* ── Main content ── */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

          {!view ? (
            /* États vides : pas de vol dans l'URL / introuvable / illisible / chargement */
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexDirection: 'column', gap: 16, padding: 24 }}>
              {status === 'none' && (
                <EmptyState text="Choose a flight in the logbook."
                  action={<Button size="sm" icon="list" onClick={() => navigate('/logbook')}>Open logbook</Button>} />
              )}
              {status === 'notfound' && (
                <Banner tone="info" title="Flight not found" style={{ width: '100%', maxWidth: 480 }}
                  action={<Button size="sm" icon="back" onClick={backToLogbook}>Back to logbook</Button>}>
                  It may have been removed from the logbook.
                </Banner>
              )}
              {status === 'error' && (
                <Banner tone="caution" title="This flight could not be loaded" style={{ width: '100%', maxWidth: 480 }}
                  action={<Button size="sm" icon="back" onClick={backToLogbook}>Back to logbook</Button>}>
                  The recording file is missing or unreadable.
                </Banner>
              )}
              {(status === 'loading' || status === 'ready') && (
                <div role="status" aria-label="Loading flight" style={{ width: 240, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                  <Skeleton width="100%" height={12} />
                  <Skeleton width="60%" height={10} />
                  <span style={{ ...monoStyle(11, T.etch), marginTop: 4 }}>LOADING FLIGHT…</span>
                </div>
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
                  <Button
                    variant={is3D ? 'primary' : 'secondary'}
                    size="sm"
                    onClick={() => setIs3D(v => !v)}
                    aria-pressed={is3D}
                    style={{
                      position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: 20,
                      fontFamily: T.mono, letterSpacing: '0.08em', padding: '0 16px', userSelect: 'none',
                    }}
                  >
                    {is3D ? '3D' : '2D'}
                  </Button>
                </div>

                {/* Six-pack */}
                <div style={{ width: 300, padding: '8px', display: 'flex', alignItems: 'center',
                  borderLeft: T.border, background: T.card }}>
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
        ::-webkit-scrollbar-thumb { background: ${T.rule}; border-radius: 2px; }
      `}</style>
    </div>
  )
}
