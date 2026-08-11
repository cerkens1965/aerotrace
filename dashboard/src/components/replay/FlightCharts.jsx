import { useRef, useEffect, useMemo, useState } from 'react'
import { subsampleFrames } from '../../utils/csvParser'

const C = {
  bg:     '#f0f2f8',
  border: 'rgba(0,0,0,0.08)',
  text:   '#0a0e1e',
  mono:   'monospace',
  amber:  '#F5A623',
  panel:  'rgba(255,255,255,0.97)',
}

const PARAMS = [
  { key: 'alt',    label: 'ALT',   unit: 'ft',  color: '#60a5fa', defaultOn: true  },
  { key: 'spd',    label: 'GS',    unit: 'km/h', mul: 1.852, color: '#22c55e', defaultOn: true  },
  { key: 'vspd',   label: 'VSI',   unit: 'fpm', color: '#a78bfa', defaultOn: false },
  { key: 'normAc', label: 'G',     unit: 'g',   color: '#f97316', defaultOn: false },
  { key: 'rpm',    label: 'RPM',   unit: '',    color: '#F5A623', defaultOn: false },
  { key: 'pitch',  label: 'PITCH', unit: '°',   color: '#34d399', defaultOn: false },
  { key: 'roll',   label: 'ROLL',  unit: '°',   color: '#f87171', defaultOn: false },
  { key: 'oat',    label: 'OAT',   unit: '°C',  color: '#67e8f9', defaultOn: false },
]

export default function FlightCharts({ frames, currentTs, height = 130, onSeek }) {
  const canvasRef = useRef(null)
  const [active, setActive] = useState(() =>
    Object.fromEntries(PARAMS.map(p => [p.key, p.defaultOn]))
  )

  const data = useMemo(() => subsampleFrames(frames || [], 1000), [frames])
  const activeParams = PARAMS.filter(p => active[p.key])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data || data.length < 2 || activeParams.length === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.width
    const H = canvas.height - 4
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    const startTs = data[0].ts
    const endTs   = data[data.length - 1].ts
    const totalTs = endTs - startTs
    const px = ts => ((ts - startTs) / totalTs) * W

    activeParams.forEach(param => {
      const vals = data.map(f => f[param.key] * (param.mul || 1)).filter(v => !isNaN(v))
      if (vals.length === 0) return
      const minV = Math.min(...vals)
      const maxV = Math.max(...vals)
      const range = maxV - minV || 1
      const py = v => H - ((v - minV) / range) * (H - 8) - 4

      // Ghost
      ctx.beginPath()
      data.forEach((f, i) => {
        i === 0 ? ctx.moveTo(px(f.ts), py(f[param.key] * (param.mul || 1))) : ctx.lineTo(px(f.ts), py(f[param.key] * (param.mul || 1)))
      })
      ctx.strokeStyle = `${param.color}55`
      ctx.lineWidth = 1.5
      ctx.stroke()

      // Played
      const played = data.filter(f => f.ts <= currentTs)
      if (played.length > 1) {
        ctx.beginPath()
        played.forEach((f, i) => {
          i === 0 ? ctx.moveTo(px(f.ts), py(f[param.key] * (param.mul || 1))) : ctx.lineTo(px(f.ts), py(f[param.key] * (param.mul || 1)))
        })
        ctx.strokeStyle = param.color
        ctx.lineWidth = 2
        ctx.stroke()
      }

      // Dot
      const cur = played[played.length - 1]
      if (cur) {
        ctx.beginPath()
        ctx.arc(px(cur.ts), py(cur[param.key] * (param.mul || 1)), 4, 0, Math.PI * 2)
        ctx.fillStyle = param.color
        ctx.fill()
        ctx.strokeStyle = '#000000'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    })

    // Cursor line
    const cx = px(currentTs)
    ctx.strokeStyle = 'rgba(245,166,35,0.7)'
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(cx, 0)
    ctx.lineTo(cx, H)
    ctx.stroke()
    ctx.setLineDash([])

  }, [data, currentTs, activeParams])

  // Drag to seek
  const handleMouseDown = (e) => {
    if (!onSeek || !data || data.length === 0) return
    const canvas = canvasRef.current
    if (!canvas) return

    const seek = (clientX) => {
      const rect = canvas.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      onSeek(data[0].ts + ratio * (data[data.length - 1].ts - data[0].ts))
    }

    seek(e.clientX)

    const onMove = (ev) => seek(ev.clientX)
    const onUp   = ()  => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  // Current values
  const curFrame = useMemo(() => {
    if (!data || !data.length) return null
    return data.find(f => f.ts >= currentTs) ?? data[data.length - 1]
  }, [data, currentTs])

  const toggle = (key) => setActive(prev => ({ ...prev, [key]: !prev[key] }))

  if (!frames || frames.length === 0) return null

  return (
    <div style={{ background: C.panel, borderTop: `1px solid ${C.border}`, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>

      {/* Toggle buttons */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {PARAMS.map(p => {
          const on = active[p.key]
          const val = curFrame && curFrame[p.key] != null ? curFrame[p.key] * (p.mul || 1) : null
          const displayVal = val != null ? (Math.abs(val) < 10 ? val.toFixed(1) : Math.round(val)) : '—'
          return (
            <button key={p.key} onClick={() => toggle(p.key)} style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
              border: `1px solid ${on ? p.color : C.border}`,
              background: on ? `${p.color}15` : 'transparent',
              transition: 'all 0.15s',
            }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: on ? p.color : 'transparent', border: `1.5px solid ${on ? p.color : 'rgba(0,0,0,0.2)'}` }} />
              <span style={{ fontFamily: C.mono, fontSize: 9, fontWeight: 700, color: on ? p.color : 'rgba(0,0,0,0.4)', letterSpacing: '0.06em' }}>{p.label}</span>
              {on && curFrame && (
                <span style={{ fontFamily: C.mono, fontSize: 9, color: C.text }}>
                  {displayVal}<span style={{ fontSize: 7, color: p.color }}>{p.unit}</span>
                </span>
              )}
            </button>
          )
        })}
      </div>

      {/* Chart */}
      <canvas
        ref={canvasRef}
        width={1200}
        height={height}
        onMouseDown={handleMouseDown}
        style={{ width: '100%', height: height, display: 'block', borderRadius: 6, cursor: 'ew-resize' }}
      />
    </div>
  )
}
