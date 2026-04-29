/**
 * FlightCharts.jsx — Synchronized flight parameter charts
 * Alt / IAS / VSpd / G-force / RPM / Pitch / Roll
 * All synchronized with the replay timeline
 */
import { useRef, useEffect, useMemo } from 'react'
import { subsampleFrames } from '../utils/csvParser'

const C = {
  bg:    '#050814',
  border:'rgba(255,255,255,0.07)',
  text:  '#ffffff',
  mono:  'monospace',
  amber: '#F5A623',
}

const CHARTS = [
  { key: 'altInd', label: 'ALT',   unit: 'ft',    color: '#60a5fa', min: null, max: null },
  { key: 'ias',    label: 'IAS',   unit: 'kt',    color: '#22c55e', min: 0,    max: null },
  { key: 'vspd',   label: 'VSI',   unit: 'fpm',   color: '#a78bfa', min: null, max: null },
  { key: 'normAc', label: 'G',     unit: 'g',     color: '#f97316', min: -2,   max: 4    },
  { key: 'rpm',    label: 'RPM',   unit: '',      color: C.amber,   min: 0,    max: null },
  { key: 'pitch',  label: 'PITCH', unit: '°',     color: '#34d399', min: -30,  max: 30   },
  { key: 'roll',   label: 'ROLL',  unit: '°',     color: '#f87171', min: -60,  max: 60   },
]

function MiniChart({ chart, frames, currentTs, width = 160, height = 50 }) {
  const canvasRef = useRef(null)

  const data = useMemo(() => subsampleFrames(frames, 800), [frames])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !data || data.length < 2) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.width
    const H = canvas.height
    ctx.clearRect(0, 0, W, H)

    // Compute min/max
    const vals = data.map(f => f[chart.key]).filter(v => !isNaN(v))
    const minV = chart.min ?? Math.min(...vals)
    const maxV = chart.max ?? Math.max(...vals)
    const range = maxV - minV || 1

    const startTs = data[0].ts
    const endTs   = data[data.length-1].ts
    const totalTs = endTs - startTs

    const px = (ts) => ((ts - startTs) / totalTs) * W
    const py = (v)  => H - ((v - minV) / range) * (H - 6) - 3

    // Zero line
    if (minV < 0 && maxV > 0) {
      const y0 = py(0)
      ctx.strokeStyle = 'rgba(255,255,255,0.1)'
      ctx.lineWidth = 0.5
      ctx.setLineDash([2,3])
      ctx.beginPath()
      ctx.moveTo(0, y0); ctx.lineTo(W, y0)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // Ghost line (full trace)
    ctx.beginPath()
    data.forEach((f, i) => {
      const x = px(f.ts)
      const y = py(f[chart.key])
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
    })
    ctx.strokeStyle = `${chart.color}25`
    ctx.lineWidth = 1
    ctx.stroke()

    // Played line
    const played = data.filter(f => f.ts <= currentTs)
    if (played.length > 1) {
      ctx.beginPath()
      played.forEach((f, i) => {
        const x = px(f.ts)
        const y = py(f[chart.key])
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)
      })
      ctx.strokeStyle = chart.color
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    // Current position line
    const curX = px(currentTs)
    ctx.strokeStyle = 'rgba(245,166,35,0.8)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(curX, 0); ctx.lineTo(curX, H)
    ctx.stroke()

    // Current value dot
    const curFrame = data.find(f => f.ts >= currentTs) ?? data[data.length-1]
    if (curFrame) {
      const dotY = py(curFrame[chart.key])
      ctx.beginPath()
      ctx.arc(curX, dotY, 3, 0, Math.PI*2)
      ctx.fillStyle = chart.color
      ctx.fill()
    }

  }, [data, currentTs, chart])

  // Current value
  const curFrame = useMemo(() => {
    if (!data || !data.length) return null
    return data.find(f => f.ts >= currentTs) ?? data[data.length-1]
  }, [data, currentTs])

  const val = curFrame ? curFrame[chart.key] : null
  const displayVal = val != null
    ? (Math.abs(val) < 10 ? val.toFixed(2) : Math.round(val))
    : '--'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 100 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
        padding: '0 4px 2px', marginBottom: 2 }}>
        <span style={{ fontFamily: C.mono, fontSize: 7, color: chart.color, letterSpacing: '0.1em' }}>
          {chart.label}
        </span>
        <span style={{ fontFamily: C.mono, fontSize: 10, fontWeight: 700, color: C.text }}>
          {displayVal}<span style={{ fontSize: 7, color: chart.color }}>{chart.unit}</span>
        </span>
      </div>
      {/* Canvas */}
      <canvas ref={canvasRef} width={200} height={height}
        style={{ width: '100%', height: height, display: 'block' }} />
    </div>
  )
}

export default function FlightCharts({ frames, currentTs, height = 90 }) {
  if (!frames || frames.length === 0) return null

  return (
    <div style={{
      background: 'rgba(5,8,20,0.95)',
      borderTop: `1px solid ${C.border}`,
      padding: '8px 12px',
      display: 'flex', gap: 8,
      height: height, overflow: 'hidden',
    }}>
      {CHARTS.map(chart => (
        <MiniChart
          key={chart.key}
          chart={chart}
          frames={frames}
          currentTs={currentTs}
          height={height - 32}
        />
      ))}
    </div>
  )
}
