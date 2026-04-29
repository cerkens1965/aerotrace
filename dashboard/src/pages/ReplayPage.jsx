import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { collection, addDoc, onSnapshot, query, where, orderBy, serverTimestamp } from 'firebase/firestore'
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import { db, storage, auth } from '../firebase/config'
import { parseG3XCSV, subsampleFrames, getFrameAtTime } from '../utils/csvParser'
import SixPack from '../components/ui/SixPack'
import ReplayMap from '../components/map/ReplayMap'
import FlightCharts from '../components/replay/FlightCharts'

// ─── Design tokens ────────────────────────────────────────────────────────────
const C = {
  bg:     '#050814',
  panel:  'rgba(10,14,30,0.95)',
  border: 'rgba(255,255,255,0.07)',
  amber:  '#F5A623',
  amber10:'rgba(245,166,35,0.10)',
  amber20:'rgba(245,166,35,0.20)',
  green:  '#22c55e',
  red:    '#ef4444',
  text:   '#ffffff',
  mid:    'rgba(255,255,255,0.55)',
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

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })
}

// ─── Upload + parse flight CSV ─────────────────────────────────────────────────
function UploadZone({ onParsed }) {
  const [dragging, setDragging]   = useState(false)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress]   = useState(0)
  const [error, setError]         = useState(null)
  const inputRef = useRef(null)

  const processFile = async (file) => {
    if (!file || !file.name.endsWith('.csv')) {
      return setError('Please select a G3X CSV file')
    }
    setUploading(true)
    setError(null)
    try {
      // Parse CSV
      const text = await file.text()
      const parsed = parseG3XCSV(text)

      // Upload to Firebase Storage
      const path = `flights/${auth.currentUser.uid}/${Date.now()}_${file.name}`
      const storageRef = ref(storage, path)
      const uploadTask = uploadBytesResumable(storageRef, file)

      uploadTask.on('state_changed',
        snap => setProgress(Math.round(snap.bytesTransferred / snap.totalBytes * 100)),
        err => { setError(err.message); setUploading(false) },
        async () => {
          const url = await getDownloadURL(uploadTask.snapshot.ref)

          // Save flight metadata to Firestore
          const flightDoc = await addDoc(collection(db, 'flights'), {
            pilotId:      auth.currentUser.uid,
            aircraftIdent: parsed.airframe.aircraft_ident,
            fileName:     file.name,
            csvStoragePath: path,
            csvUrl:       url,
            startTs:      parsed.stats.startTs,
            endTs:        parsed.stats.endTs,
            duration:     parsed.stats.duration,
            maxAlt:       parsed.stats.maxAlt,
            maxSpd:       parsed.stats.maxSpd,
            maxG:         parsed.stats.maxG,
            maxRpm:       parsed.stats.maxRpm,
            bounds:       parsed.stats.bounds,
            uploadedAt:   serverTimestamp(),
          })

          onParsed({ ...parsed, flightId: flightDoc.id })
          setUploading(false)
        }
      )
    } catch (e) {
      setError(e.message)
      setUploading(false)
    }
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
          { l: 'SPD', v: `${flight.maxSpd}kt` },
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

// ─── Map canvas trace ─────────────────────────────────────────────────────────
function TraceMap({ frames, currentFrame, bounds }) {
  const canvasRef = useRef(null)
  const containerRef = useRef(null)

  const project = useCallback((lat, lon, w, h) => {
    if (!bounds) return { x: 0, y: 0 }
    const pad = 20
    const x = pad + ((lon - bounds.minLon) / (bounds.maxLon - bounds.minLon)) * (w - pad*2)
    const y = pad + (1 - (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * (h - pad*2)
    return { x, y }
  }, [bounds])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !frames || frames.length === 0) return
    const { width: w, height: h } = canvas

    const ctx = canvas.getContext('2d')
    ctx.clearRect(0, 0, w, h)

    // Draw trail
    const sub = subsampleFrames(frames, 3000)
    for (let i = 1; i < sub.length; i++) {
      const a = project(sub[i-1].lat, sub[i-1].lon, w, h)
      const b = project(sub[i].lat, sub[i].lon, w, h)
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.strokeStyle = sub[i].color ?? '#22c55e'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // Current position
    if (currentFrame) {
      const pos = project(currentFrame.lat, currentFrame.lon, w, h)
      ctx.beginPath()
      ctx.arc(pos.x, pos.y, 6, 0, Math.PI*2)
      ctx.fillStyle = C.amber
      ctx.fill()
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1.5
      ctx.stroke()

      // Heading line
      const hdgRad = (currentFrame.hdg - 90) * Math.PI/180
      ctx.beginPath()
      ctx.moveTo(pos.x, pos.y)
      ctx.lineTo(pos.x + Math.cos(hdgRad) * 20, pos.y + Math.sin(hdgRad) * 20)
      ctx.strokeStyle = C.amber
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }, [frames, currentFrame, project])

  return (
    <div ref={containerRef} style={{ flex: 1, position: 'relative', background: '#0a0e1e', borderRadius: 10,
      border: `1px solid ${C.border}`, overflow: 'hidden' }}>
      <canvas ref={canvasRef} width={800} height={400}
        style={{ width: '100%', height: '100%' }} />
      {/* Phase legend */}
      <div style={{ position: 'absolute', top: 10, right: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {Object.entries(PHASE_COLORS).map(([phase, color]) => (
          <div key={phase} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 12, height: 3, background: color, borderRadius: 1 }} />
            <span style={{ fontFamily: C.mono, fontSize: 7, color: C.mid }}>{phase}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Timeline scrubber ────────────────────────────────────────────────────────
function Timeline({ frames, currentTs, onSeek, playing, onPlayPause, speed, onSpeedChange }) {
  if (!frames || frames.length === 0) return null
  const startTs = frames[0].ts
  const endTs   = frames[frames.length-1].ts
  const total   = endTs - startTs
  const progress = ((currentTs - startTs) / total) * 100

  const isDragging = useRef(false)
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
            boxShadow: '0 0 8px rgba(245,166,35,0.8)',
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
    { l: 'IAS',   v: `${Math.round(frame.ias)}kt` },
    { l: 'ALT',   v: `${Math.round(frame.altInd)}ft` },
    { l: 'AGL',   v: `${Math.round(frame.agl)}ft` },
    { l: 'VSI',   v: `${frame.vspd > 0 ? '+' : ''}${Math.round(frame.vspd)}fpm` },
    { l: 'HDG',   v: `${Math.round(frame.hdg)}°` },
    { l: 'G',     v: `${frame.normAc.toFixed(2)}g`, alert: Math.abs(frame.normAc) > 2 },
    { l: 'RPM',   v: Math.round(frame.rpm) },
    { l: 'OAT',   v: `${Math.round(frame.oat)}°C` },
    { l: 'PHASE', v: frame.phase, color: PHASE_COLORS[frame.phase] },
  ]
  return (
    <div style={{ display: 'flex', gap: 0, background: 'rgba(5,8,20,0.9)',
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
  const [flights, setFlights]       = useState([])
  const [selected, setSelected]     = useState(null)   // flight metadata
  const [parsed, setParsed]         = useState(null)   // { frames, stats, airframe }
  const [currentTs, setCurrentTs]   = useState(0)
  const [playing, setPlaying]       = useState(false)
  const [speed, setSpeed]           = useState(1)
  const [showUpload, setShowUpload] = useState(false)
  const [sideOpen, setSideOpen]     = useState(true)
  const [is3D, setIs3D]             = useState(false)
  const animRef = useRef(null)
  const lastTimeRef = useRef(null)

  // Load flight list
  useEffect(() => {
    if (!user) return
    const q = query(collection(db, 'flights'), where('pilotId', '==', user.uid), orderBy('startTs', 'desc'))
    return onSnapshot(q, snap => setFlights(snap.docs.map(d => ({ id: d.id, ...d.data() }))))
  }, [user])

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

  const handlePlayPause = () => {
    lastTimeRef.current = null
    setPlaying(p => !p)
  }

  const handleSeek = (ts) => {
    lastTimeRef.current = null
    setCurrentTs(ts)
    setPlaying(false)
  }

  const handleParsed = (data) => {
    setParsed(data)
    setCurrentTs(data.frames[0].ts)
    setPlaying(false)
    setShowUpload(false)
  }

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
                  <UploadZone onParsed={handleParsed} />
                </div>
              )}

              {/* Flight list */}
              {flights.length === 0 && !showUpload && (
                <div style={{ fontFamily: C.mono, fontSize: 9, color: C.mid, textAlign: 'center', padding: 16 }}>
                  No flights yet.<br/>Import a G3X CSV.
                </div>
              )}
              {flights.map(f => (
                <FlightItem key={f.id} flight={f} selected={selected?.id === f.id}
                  onSelect={async (fl) => {
                    setSelected(fl)
                    // Load CSV from storage URL
                    try {
                      const res = await fetch(fl.csvUrl)
                      const text = await res.text()
                      const p = parseG3XCSV(text)
                      setParsed(p)
                      setCurrentTs(p.frames[0].ts)
                      setPlaying(false)
                    } catch(e) { console.error('Load CSV:', e) }
                  }}
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
                  <ReplayMap frames={parsed.frames} currentFrame={currentFrame} is3D={is3D} />
                  {/* 2D/3D toggle */}
                  <div style={{ position: 'absolute', top: 10, left: 10, display: 'flex', gap: 4, zIndex: 10 }}>
                    {['2D','3D'].map(mode => (
                      <button key={mode} onClick={() => setIs3D(mode === '3D')} style={{
                        padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
                        fontFamily: 'monospace', fontSize: 9, fontWeight: 700,
                        background: (mode === '3D') === is3D ? 'rgba(245,166,35,0.2)' : 'rgba(5,8,20,0.8)',
                        border: `1px solid ${(mode === '3D') === is3D ? '#F5A623' : 'rgba(255,255,255,0.1)'}`,
                        color: (mode === '3D') === is3D ? '#F5A623' : '#ffffff',
                      }}>{mode}</button>
                    ))}
                  </div>
                </div>

                {/* Six-pack */}
                <div style={{ width: 300, padding: '8px', display: 'flex', alignItems: 'center',
                  borderLeft: '1px solid rgba(255,255,255,0.07)', background: 'rgba(5,8,20,0.9)' }}>
                  <SixPack frame={currentFrame} size={110} />
                </div>
              </div>

              {/* Data strip */}
              <DataStrip frame={currentFrame} />

              {/* Flight charts */}
              <FlightCharts frames={parsed.frames} currentTs={currentTs} height={100} />
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
