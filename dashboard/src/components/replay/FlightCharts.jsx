import { useRef, useEffect, useMemo, useState } from 'react'
import { subsampleFrames } from '../../utils/csvParser'
import { T } from '../ui'

// (22/09) Charte AirKi : carte blanche, bord 1 px, texte encre ; la couleur n'est portée que par la courbe et la pastille
// (jamais par le texte, jamais de rouge ni d'orange). Série de couleurs limitée aux jetons + deux gris chauds.
const C = {
  border: T.rule,
  text:   T.ink,
  mono:   T.mono,
  panel:  T.card,
}

const PARAMS = [
  { key: 'alt',    label: 'ALT',   unit: 'ft',  color: T.info,     defaultOn: true  },
  { key: 'spd',    label: 'GS',    unit: 'kt',  color: T.ok,       defaultOn: true  },   // (22/09) kt, comme partout (avant km/h)
  { key: 'vspd',   label: 'VSI',   unit: 'fpm', color: T.ink,      defaultOn: false },
  { key: 'normAc', label: 'G',     unit: 'g',   color: T.amber,    defaultOn: false },
  { key: 'rpm',    label: 'RPM',   unit: '',    color: T.graphite, defaultOn: false },
  { key: 'pitch',  label: 'PITCH', unit: '°',   color: T.etch,     defaultOn: false },
  { key: 'roll',   label: 'ROLL',  unit: '°',   color: '#B9B4AA',  defaultOn: false },
  { key: 'oat',    label: 'OAT',   unit: '°C',  color: '#6FA8DC',  defaultOn: false },
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
        ctx.strokeStyle = T.ink
        ctx.lineWidth = 1
        ctx.stroke()
      }
    })

    // Curseur de lecture — (23/09) SEULE marque de position depuis la suppression de la barre
    // de progression : trait PLEIN (avant : pointillé pâle) + poignée au pied, pour qu'on voie
    // tout de suite où on en est et que la zone se devine « grattable ».
    const cx = px(currentTs)
    ctx.strokeStyle = T.amber
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(cx, 0)
    ctx.lineTo(cx, H)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(cx - 5, H); ctx.lineTo(cx + 5, H); ctx.lineTo(cx, H - 7); ctx.closePath()
    ctx.fillStyle = T.amber
    ctx.fill()

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

  const toggle = (key) => setActive(prev => ({ ...prev, [key]: !prev[key] }))

  if (!frames || frames.length === 0) return null

  return (
    <div style={{ background: C.panel, borderTop: `1px solid ${C.border}`, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>

      {/* Séries à tracer — (23/09) pastilles SANS valeur : le bandeau d'instruments juste
          au-dessus affiche déjà les 9 mesures de l'instant, en plus gros. Ici on choisit
          ce qu'on trace, rien d'autre. */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontFamily: C.mono, fontSize: 10, fontWeight: 500, color: T.etch, letterSpacing: '0.08em', marginRight: 2 }}>PLOT</span>
        {PARAMS.map(p => {
          const on = active[p.key]
          return (
            <button key={p.key} type="button" className="ak-focus" aria-pressed={on} onClick={() => toggle(p.key)} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '3px 8px', borderRadius: T.radius.sm, cursor: 'pointer',
              border: `1px solid ${on ? T.ink : C.border}`, background: T.card,
            }}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: T.radius.pill, background: on ? p.color : 'transparent', border: `1.5px solid ${on ? p.color : T.etch}` }} />
              <span style={{ fontFamily: C.mono, fontSize: 10, fontWeight: 500, color: on ? T.ink : T.etch, letterSpacing: '0.08em' }}>
                {p.label}{p.unit ? ` ${p.unit}` : ''}
              </span>
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
        style={{ width: '100%', height: height, display: 'block', borderRadius: T.radius.md, cursor: 'ew-resize' }}
      />
    </div>
  )
}
