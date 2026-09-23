import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { getDoc, doc } from 'firebase/firestore'
import { ref, getDownloadURL } from 'firebase/storage'
import { db, storage } from '../firebase/config'
import { parseG3XCSV, getFrameAtTime } from '../utils/csvParser'   // (23/09) subsampleFrames n'est plus utilisé ici : la barre de progression (et ses barres de phase) a été supprimée
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

// ─── Barre de lecture ─────────────────────────────────────────────────────────
// (23/09, Christophe) La BARRE DE PROGRESSION a été SUPPRIMÉE : elle faisait double emploi
// avec les courbes juste au-dessus, qui portent déjà la position de lecture (curseur ambre,
// tracé joué en plein / à venir en fantôme) et se laissent déjà gratter à la souris.
// Reste ici ce que les courbes ne disent pas : lecture/pause, temps écoulé, heure UTC, vitesse.
function Timeline({ frames, currentTs, playing, onPlayPause, speed, onSpeedChange }) {
  if (!frames || frames.length === 0) return null
  const startTs = frames[0].ts
  const total   = frames[frames.length - 1].ts - startTs

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
      padding: '10px 16px', background: T.card, borderTop: T.border }}>

      <Button variant="primary" size="sm" onClick={onPlayPause} aria-label={playing ? 'Pause' : 'Play'}
        style={{ width: 34, height: 34, padding: 0, flexShrink: 0 }}>
        {playing
          ? <svg viewBox="0 0 24 24" width={15} height={15} aria-hidden="true" style={{ display: 'block' }}>
              <rect x={6} y={4} width={4} height={16} fill="currentColor" /><rect x={14} y={4} width={4} height={16} fill="currentColor" />
            </svg>
          : <Icon name="play" size={15} />}
      </Button>

      {/* Temps écoulé (gros) puis l'heure UTC correspondante (discrète) */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ ...monoStyle(15, T.ink), fontWeight: 500, minWidth: 58 }}>{fmtTime(currentTs - startTs)}</span>
        <span style={{ ...monoStyle(11, T.graphite) }}>{fmtUTC(currentTs)}</span>
      </div>

      {/* Vitesse de lecture — mêmes pastilles que les séries des courbes */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={labelStyle(T.etch)}>SPEED</span>
        <div style={{ display: 'flex', gap: 4 }}>
          {[1, 2, 5, 10, 30].map(sp => (
            <button key={sp} onClick={() => onSpeedChange(sp)} className="ak-focus" aria-pressed={speed === sp} style={{
              padding: '4px 9px', borderRadius: T.radius.sm, cursor: 'pointer',
              background: speed === sp ? T.ink : T.card,
              border: `1px solid ${speed === sp ? T.ink : T.rule}`,
              color: speed === sp ? T.white : T.graphite,
              fontFamily: T.mono, fontSize: 11, fontWeight: 500, fontVariantNumeric: 'tabular-nums',
            }}>{sp}x</button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, minWidth: 8 }} />

      {/* Durée totale, et l'heure de fin dessous — l'échelle des courbes, en clair */}
      <div style={{ textAlign: 'right' }}>
        <div style={labelStyle(T.etch)}>TOTAL</div>
        <div style={{ ...monoStyle(13, T.ink), fontWeight: 500, marginTop: 2 }}>
          {fmtTime(total)}<span style={{ color: T.graphite, marginLeft: 8 }}>{fmtUTC(startTs + total)}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Bandeau d'instruments ────────────────────────────────────────────────────
// (23/09) Redessiné : libellé + UNITÉ en capitales 10 px etch, valeur Geist Mono 20 px encre
// tabulaire (les chiffres ne dansent plus quand la lecture défile), colonnes de largeur fixe
// séparées par un filet 1 px. La couleur reste portée par une pastille, jamais par le texte.
function DataStrip({ frame }) {
  if (!frame) return null
  const n = (v, f = (x) => String(Math.round(x))) => (v == null || Number.isNaN(v) ? '−−−' : f(v))
  const items = [
    { l: 'GS',    u: 'KT',  v: n(frame.spd),  w: 54 },
    { l: 'ALT',   u: 'FT',  v: n(frame.alt),  w: 62 },
    { l: 'AGL',   u: 'FT',  v: n(frame.agl),  w: 62 },
    { l: 'VSI',   u: 'FPM', v: n(frame.vspd, x => `${x > 0 ? '+' : ''}${Math.round(x)}`), w: 70 },
    { l: 'HDG',   u: '',    v: n(frame.hdg, x => String(Math.round(x) % 360).padStart(3, '0')), w: 54 },
    { l: 'G',     u: '',    v: n(frame.normAc, x => x.toFixed(2)), w: 54, dot: Math.abs(frame.normAc) > 2 ? T.amber : null },
    { l: 'RPM',   u: '',    v: n(frame.rpm),  w: 58 },
    { l: 'OAT',   u: '°C',  v: n(frame.oat),  w: 54 },
    { l: 'PHASE', u: '',    v: frame.phase,   w: 104, dot: PHASE_COLORS[frame.phase], text: true },
  ]
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch',
      background: T.card, borderTop: T.border }}>
      {items.map((item, i) => (
        <div key={item.l} style={{ minWidth: item.w, padding: '7px 14px',
          borderLeft: i === 0 ? 'none' : T.border }}>
          <div style={labelStyle(T.etch)}>{item.u ? `${item.l} ${item.u}` : item.l}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 3 }}>
            {item.dot && <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: T.radius.pill,
              background: item.dot, flexShrink: 0 }} />}
            <span style={{ ...monoStyle(item.text ? 12 : 15, T.ink), fontWeight: 500, lineHeight: 1 }}>{item.v}</span>
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
        if (!snap.exists()) { setResult({ flightId, status: 'notfound' }); return }   // (21/09) un vol ARCHIVÉ reste lisible (l'archive sert à garder la trace)
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
      {shown?.archived && (
        <Banner tone="info" title="Archived flight" style={{ margin: '0 16px 8px' }}>
          Kept for reading: this flight is hidden from the logbook lists and totals. Restore or purge it in Logbook → Archived.
        </Banner>
      )}

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
                  It has been purged from the logbook, with its recording.
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
