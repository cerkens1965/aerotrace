/**
 * SixPack.jsx — Cockpit instruments for AeroTrace REPLAY
 * ADI / Airspeed / Altimeter / VSI / Heading / Turn Coordinator
 */
import { useRef, useEffect } from 'react'

const C = {
  bg:     '#050814',
  panel:  'rgba(10,14,30,0.95)',
  border: 'rgba(255,255,255,0.08)',
  amber:  '#F5A623',
  text:   '#ffffff',
  mono:   'monospace',
}

// ─── Canvas instrument base ───────────────────────────────────────────────────
function Instrument({ label, size = 110, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{
        width: size, height: size, borderRadius: '50%',
        background: 'radial-gradient(circle at 30% 30%, #1a2040, #050814)',
        border: `2px solid ${C.border}`,
        boxShadow: '0 0 20px rgba(0,0,0,0.8), inset 0 0 30px rgba(0,0,0,0.5)',
        position: 'relative', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {children}
      </div>
      <span style={{ fontFamily: C.mono, fontSize: 8, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.5)' }}>
        {label}
      </span>
    </div>
  )
}

// ─── ADI — Attitude Direction Indicator ──────────────────────────────────────
function ADI({ pitch = 0, roll = 0, size = 110 }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const cx = size / 2, cy = size / 2, r = size / 2 - 2

    ctx.clearRect(0, 0, size, size)

    // Clip to circle
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.clip()

    // Rotate for roll
    ctx.translate(cx, cy)
    ctx.rotate((roll * Math.PI) / 180)
    ctx.translate(-cx, -cy)

    // Horizon offset for pitch (2px per degree)
    const pitchOffset = pitch * 2

    // Sky
    ctx.fillStyle = '#1a4a8a'
    ctx.fillRect(0, 0, size, cy + pitchOffset)

    // Ground
    ctx.fillStyle = '#6b3a1f'
    ctx.fillRect(0, cy + pitchOffset, size, size)

    // Horizon line
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(0, cy + pitchOffset)
    ctx.lineTo(size, cy + pitchOffset)
    ctx.stroke()

    // Pitch lines
    for (let p = -20; p <= 20; p += 5) {
      if (p === 0) continue
      const y = cy + pitchOffset - p * 2
      const w = p % 10 === 0 ? 24 : 14
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(cx - w, y)
      ctx.lineTo(cx + w, y)
      ctx.stroke()
    }

    ctx.restore()

    // Fixed aircraft symbol (amber)
    ctx.strokeStyle = C.amber
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx - 20, cy); ctx.lineTo(cx - 8, cy)
    ctx.moveTo(cx - 8, cy); ctx.lineTo(cx - 4, cy + 4)
    ctx.moveTo(cx - 4, cy + 4); ctx.lineTo(cx, cy + 4)
    ctx.moveTo(cx, cy + 4); ctx.lineTo(cx + 4, cy + 4)
    ctx.moveTo(cx + 4, cy + 4); ctx.lineTo(cx + 8, cy)
    ctx.moveTo(cx + 8, cy); ctx.lineTo(cx + 20, cy)
    ctx.stroke()

    // Center dot
    ctx.fillStyle = C.amber
    ctx.beginPath()
    ctx.arc(cx, cy, 2, 0, Math.PI * 2)
    ctx.fill()

  }, [pitch, roll, size])

  return <canvas ref={canvasRef} width={size} height={size} style={{ borderRadius: '50%' }} />
}

// ─── Airspeed Indicator ───────────────────────────────────────────────────────
function AirspeedIndicator({ ias = 0, size = 110 }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const cx = size/2, cy = size/2, r = size/2 - 4

    ctx.clearRect(0, 0, size, size)
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI*2)
    ctx.clip()

    // Speed arc colors (green 60-120kt, yellow 120-140kt)
    const drawArc = (start, end, color) => {
      const s = ((start/200) * 270 - 225) * Math.PI/180
      const e = ((end/200) * 270 - 225) * Math.PI/180
      ctx.beginPath()
      ctx.arc(cx, cy, r-4, s, e)
      ctx.strokeStyle = color
      ctx.lineWidth = 4
      ctx.stroke()
    }
    drawArc(60, 120, '#22c55e')
    drawArc(120, 140, '#eab308')
    drawArc(140, 160, '#ef4444')

    // Tick marks
    for (let v = 0; v <= 200; v += 10) {
      const angle = (v/200 * 270 - 225) * Math.PI/180
      const isMajor = v % 20 === 0
      const r1 = r - (isMajor ? 10 : 6)
      ctx.beginPath()
      ctx.moveTo(cx + r1 * Math.cos(angle), cy + r1 * Math.sin(angle))
      ctx.lineTo(cx + (r-6) * Math.cos(angle), cy + (r-6) * Math.sin(angle))
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'
      ctx.lineWidth = isMajor ? 1.5 : 1
      ctx.stroke()

      if (isMajor && v > 0) {
        ctx.fillStyle = '#ffffff'
        ctx.font = `${size < 100 ? 7 : 8}px monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const tr = r - 18
        ctx.fillText(v, cx + tr * Math.cos(angle), cy + tr * Math.sin(angle))
      }
    }

    // Needle
    const angle = (Math.min(ias, 200)/200 * 270 - 225) * Math.PI/180
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + (r-8) * Math.cos(angle), cy + (r-8) * Math.sin(angle))
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.stroke()

    // Center
    ctx.beginPath()
    ctx.arc(cx, cy, 4, 0, Math.PI*2)
    ctx.fillStyle = '#333'
    ctx.fill()

    ctx.restore()

    // Digital readout
    ctx.fillStyle = C.amber
    ctx.font = `bold ${size < 100 ? 10 : 11}px monospace`
    ctx.textAlign = 'center'
    ctx.fillText(`${Math.round(ias)}kt`, cx, cy + 22)
  }, [ias, size])

  return <canvas ref={canvasRef} width={size} height={size} style={{ borderRadius: '50%' }} />
}

// ─── Altimeter ────────────────────────────────────────────────────────────────
function Altimeter({ alt = 0, size = 110 }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const cx = size/2, cy = size/2, r = size/2 - 4

    ctx.clearRect(0, 0, size, size)
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI*2)
    ctx.clip()

    // 100ft needle (short)
    const hundreds = (alt % 1000) / 1000
    const angle100 = (hundreds * 360 - 90) * Math.PI/180
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + (r-14) * Math.cos(angle100), cy + (r-14) * Math.sin(angle100))
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Tick marks
    for (let i = 0; i < 10; i++) {
      const angle = (i * 36 - 90) * Math.PI/180
      const isMajor = i % 2 === 0
      ctx.beginPath()
      ctx.moveTo(cx + (r - (isMajor ? 10 : 6)) * Math.cos(angle), cy + (r - (isMajor ? 10 : 6)) * Math.sin(angle))
      ctx.lineTo(cx + (r-3) * Math.cos(angle), cy + (r-3) * Math.sin(angle))
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'
      ctx.lineWidth = isMajor ? 1.5 : 1
      ctx.stroke()
      if (isMajor) {
        ctx.fillStyle = '#ffffff'
        ctx.font = `${size < 100 ? 7 : 8}px monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const tr = r - 18
        ctx.fillText(i === 0 ? '0' : i*1, cx + tr * Math.cos(angle), cy + tr * Math.sin(angle))
      }
    }

    // 1000ft needle (long)
    const thousands = alt / 10000
    const angle1000 = (thousands * 360 - 90) * Math.PI/180
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + (r-6) * Math.cos(angle1000), cy + (r-6) * Math.sin(angle1000))
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(cx, cy, 4, 0, Math.PI*2)
    ctx.fillStyle = '#333'
    ctx.fill()
    ctx.restore()

    // Digital
    ctx.fillStyle = C.amber
    ctx.font = `bold ${size < 100 ? 10 : 11}px monospace`
    ctx.textAlign = 'center'
    ctx.fillText(`${Math.round(alt)}ft`, cx, cy + 22)
  }, [alt, size])

  return <canvas ref={canvasRef} width={size} height={size} style={{ borderRadius: '50%' }} />
}

// ─── VSI — Vertical Speed ─────────────────────────────────────────────────────
function VSI({ vspd = 0, size = 110 }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const cx = size/2, cy = size/2, r = size/2 - 4

    ctx.clearRect(0, 0, size, size)
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI*2)
    ctx.clip()

    // Scale: -2000 to +2000 fpm, 270° sweep
    const ticks = [-2000,-1000,-500,0,500,1000,2000]
    ticks.forEach(v => {
      const norm = (v + 2000) / 4000
      const angle = (norm * 270 - 225) * Math.PI/180
      const isMajor = v % 1000 === 0
      ctx.beginPath()
      ctx.moveTo(cx + (r - (isMajor ? 10 : 6)) * Math.cos(angle), cy + (r - (isMajor ? 10 : 6)) * Math.sin(angle))
      ctx.lineTo(cx + (r-3) * Math.cos(angle), cy + (r-3) * Math.sin(angle))
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'
      ctx.lineWidth = isMajor ? 1.5 : 1
      ctx.stroke()
      if (isMajor) {
        ctx.fillStyle = v === 0 ? C.amber : '#ffffff'
        ctx.font = `${size < 100 ? 7 : 8}px monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const tr = r - 18
        ctx.fillText(Math.abs(v/100), cx + tr * Math.cos(angle), cy + tr * Math.sin(angle))
      }
    })

    // Needle
    const clamped = Math.max(-2000, Math.min(2000, vspd))
    const norm = (clamped + 2000) / 4000
    const angle = (norm * 270 - 225) * Math.PI/180
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + (r-6) * Math.cos(angle), cy + (r-6) * Math.sin(angle))
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(cx, cy, 4, 0, Math.PI*2)
    ctx.fillStyle = '#333'
    ctx.fill()
    ctx.restore()

    // Digital
    const color = vspd > 100 ? '#22c55e' : vspd < -100 ? '#ef4444' : C.amber
    ctx.fillStyle = color
    ctx.font = `bold ${size < 100 ? 10 : 11}px monospace`
    ctx.textAlign = 'center'
    ctx.fillText(`${vspd > 0 ? '+' : ''}${Math.round(vspd)}`, cx, cy + 22)
  }, [vspd, size])

  return <canvas ref={canvasRef} width={size} height={size} style={{ borderRadius: '50%' }} />
}

// ─── Heading Indicator ────────────────────────────────────────────────────────
function HeadingIndicator({ hdg = 0, trk = 0, size = 110 }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const cx = size/2, cy = size/2, r = size/2 - 4

    ctx.clearRect(0, 0, size, size)
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI*2)
    ctx.clip()

    // Rotate compass rose
    ctx.translate(cx, cy)
    ctx.rotate((-hdg * Math.PI) / 180)
    ctx.translate(-cx, -cy)

    const cardinals = ['N','E','S','W']
    for (let i = 0; i < 36; i++) {
      const angle = (i * 10 - 90) * Math.PI/180
      const isMajor = i % 3 === 0
      ctx.beginPath()
      ctx.moveTo(cx + (r - (isMajor ? 10 : 5)) * Math.cos(angle), cy + (r - (isMajor ? 10 : 5)) * Math.sin(angle))
      ctx.lineTo(cx + (r-2) * Math.cos(angle), cy + (r-2) * Math.sin(angle))
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'
      ctx.lineWidth = isMajor ? 1.5 : 0.5
      ctx.stroke()

      if (i % 9 === 0) {
        ctx.fillStyle = i === 0 ? '#ef4444' : '#ffffff'
        ctx.font = `bold ${size < 100 ? 8 : 9}px monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const tr = r - 18
        ctx.fillText(cardinals[i/9], cx + tr * Math.cos(angle), cy + tr * Math.sin(angle))
      }
    }

    // Track bug (green)
    const trkAngle = ((trk - hdg) * Math.PI) / 180 - Math.PI/2
    ctx.strokeStyle = '#22c55e'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx + (r-8) * Math.cos(trkAngle), cy + (r-8) * Math.sin(trkAngle))
    ctx.lineTo(cx + (r-3) * Math.cos(trkAngle), cy + (r-3) * Math.sin(trkAngle))
    ctx.stroke()

    ctx.restore()

    // Fixed lubber line
    ctx.strokeStyle = C.amber
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx, cy - r + 2)
    ctx.lineTo(cx, cy - r + 12)
    ctx.stroke()

    // Digital
    ctx.fillStyle = C.amber
    ctx.font = `bold ${size < 100 ? 10 : 11}px monospace`
    ctx.textAlign = 'center'
    ctx.fillText(`${Math.round(hdg).toString().padStart(3,'0')}°`, cx, cy + 22)
  }, [hdg, trk, size])

  return <canvas ref={canvasRef} width={size} height={size} style={{ borderRadius: '50%' }} />
}

// ─── Turn Coordinator ─────────────────────────────────────────────────────────
function TurnCoordinator({ roll = 0, latAc = 0, size = 110 }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const cx = size/2, cy = size/2, r = size/2 - 4

    ctx.clearRect(0, 0, size, size)
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI*2)
    ctx.clip()

    // Bank marks
    const bankAngles = [-30, -20, -10, 0, 10, 20, 30]
    bankAngles.forEach(b => {
      const angle = (b - 90) * Math.PI/180
      const isMajor = b % 30 === 0
      ctx.beginPath()
      ctx.moveTo(cx + (r - (isMajor ? 10 : 6)) * Math.cos(angle), cy + (r - (isMajor ? 10 : 6)) * Math.sin(angle))
      ctx.lineTo(cx + (r-2) * Math.cos(angle), cy + (r-2) * Math.sin(angle))
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'
      ctx.lineWidth = isMajor ? 1.5 : 1
      ctx.stroke()
    })

    // Miniature aircraft rotated by roll
    ctx.translate(cx, cy)
    ctx.rotate((roll * Math.PI) / 180)
    ctx.strokeStyle = C.amber
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(-18, 4); ctx.lineTo(-6, 4)
    ctx.moveTo(-6, 4); ctx.lineTo(0, 0)
    ctx.moveTo(0, 0); ctx.lineTo(6, 4)
    ctx.moveTo(6, 4); ctx.lineTo(18, 4)
    ctx.moveTo(-4, 14); ctx.lineTo(4, 14)
    ctx.stroke()
    ctx.restore()

    // Ball (slip indicator) — displaced by lateral acceleration
    const ballOffset = Math.max(-20, Math.min(20, latAc * 30))
    ctx.beginPath()
    ctx.arc(cx + ballOffset, cy + r - 12, 5, 0, Math.PI*2)
    ctx.fillStyle = '#ffffff'
    ctx.fill()
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 1
    ctx.stroke()

  }, [roll, latAc, size])

  return <canvas ref={canvasRef} width={size} height={size} style={{ borderRadius: '50%' }} />
}

// ─── Main SixPack component ───────────────────────────────────────────────────
export default function SixPack({ frame, size = 110 }) {
  if (!frame) return (
    <div style={{ display: 'flex', gap: 12, padding: 16,
      background: 'rgba(5,8,20,0.8)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.07)' }}>
      {['ADI','AIRSPEED','ALTITUDE','VSI','HEADING','TURN'].map(l => (
        <Instrument key={l} label={l} size={size}>
          <span style={{ fontFamily: 'monospace', fontSize: 9, color: 'rgba(255,255,255,0.2)' }}>--</span>
        </Instrument>
      ))}
    </div>
  )

  return (
    <div style={{ display: 'flex', gap: 12, padding: 16,
      background: 'rgba(5,8,20,0.8)', borderRadius: 10, border: '1px solid rgba(255,255,255,0.07)',
      flexWrap: 'wrap', justifyContent: 'center' }}>

      <Instrument label="ADI" size={size}>
        <ADI pitch={frame.pitch} roll={frame.roll} size={size} />
      </Instrument>

      <Instrument label="AIRSPEED" size={size}>
        <AirspeedIndicator ias={frame.ias} size={size} />
      </Instrument>

      <Instrument label="ALTITUDE" size={size}>
        <Altimeter alt={frame.altInd} size={size} />
      </Instrument>

      <Instrument label="VSI" size={size}>
        <VSI vspd={frame.vspd} size={size} />
      </Instrument>

      <Instrument label="HEADING" size={size}>
        <HeadingIndicator hdg={frame.hdg} trk={frame.trk} size={size} />
      </Instrument>

      <Instrument label="TURN" size={size}>
        <TurnCoordinator roll={frame.roll} latAc={frame.latAc} size={size} />
      </Instrument>

    </div>
  )
}
