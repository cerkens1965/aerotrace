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
  // (23/09, Christophe : « les traits du graphique sont flous ») Le canvas était figé à
  // 1200 px de large puis ÉTIRÉ en CSS à la largeur réelle : tout était interpolé, traits
  // épaissis et baveux. On le dimensionne maintenant à sa taille affichée × la densité
  // d'écran, et on dessine en pixels CSS (ctx.scale) → 1 px demandé = 1 px affiché.
  const [cssW, setCssW] = useState(0)
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setCssW(Math.round(e.contentRect.width)))
    ro.observe(el)
    setCssW(Math.round(el.getBoundingClientRect().width))
    return () => ro.disconnect()
  }, [])

  const data = useMemo(() => subsampleFrames(frames || [], 1000), [frames])
  const activeParams = PARAMS.filter(p => active[p.key])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !cssW || !data || data.length < 2 || activeParams.length === 0) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 3)
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width  = Math.round(cssW * dpr)
      canvas.height = Math.round(height * dpr)
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)   // tout se dessine en pixels CSS
    const W = cssW
    const H = height - 4
    ctx.clearRect(0, 0, W, height)

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

      ctx.lineJoin = 'round'; ctx.lineCap = 'round'

      // À venir : le tracé complet, en retrait
      ctx.beginPath()
      data.forEach((f, i) => {
        i === 0 ? ctx.moveTo(px(f.ts), py(f[param.key] * (param.mul || 1))) : ctx.lineTo(px(f.ts), py(f[param.key] * (param.mul || 1)))
      })
      ctx.strokeStyle = `${param.color}40`
      ctx.lineWidth = 1
      ctx.stroke()

      // Déjà joué : même trait, à peine plus appuyé (avant : 2 px, trop lourd)
      const played = data.filter(f => f.ts <= currentTs)
      if (played.length > 1) {
        ctx.beginPath()
        played.forEach((f, i) => {
          i === 0 ? ctx.moveTo(px(f.ts), py(f[param.key] * (param.mul || 1))) : ctx.lineTo(px(f.ts), py(f[param.key] * (param.mul || 1)))
        })
        ctx.strokeStyle = param.color
        ctx.lineWidth = 1.25
        ctx.stroke()
      }
      // (23/09) PLUS DE PASTILLE au point courant : une boule cerclée par série faisait
      // un chapelet de billes sur le curseur, et la valeur exacte est déjà lue en grand
      // dans le bandeau d'instruments juste au-dessus.
    })

    // Curseur de lecture — (23/09) SEULE marque de position depuis la suppression de la barre
    // de progression : trait PLEIN (avant : pointillé pâle) + poignée au pied, pour qu'on voie
    // tout de suite où on en est et que la zone se devine « grattable ».
    const cx = Math.round(px(currentTs)) + 0.5   // + 0.5 → trait de 1 px vraiment net
    ctx.strokeStyle = T.ink                      // encre, pas ambre : l'ambre sert déjà à la courbe G
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(cx, 0)
    ctx.lineTo(cx, H)
    ctx.stroke()

  }, [data, currentTs, activeParams, cssW, height])

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
            // (23/09, Christophe : « on ne voit pas assez ce qui est sélectionné ») La série
            // tracée prend le FOND ENCRE et un texte blanc — le même marqueur de sélection que
            // les vitesses de lecture juste en dessous. Avant, actif et inactif ne différaient
            // que par la teinte du filet et du texte : illisible à 10 px. La pastille garde la
            // couleur RÉELLE de la courbe (cerclée de blanc pour ressortir sur l'encre).
            <button key={p.key} type="button" className="ak-focus" aria-pressed={on} onClick={() => toggle(p.key)} style={{
              display: 'flex', alignItems: 'center', gap: 7,
              padding: '4px 9px', borderRadius: T.radius.sm, cursor: 'pointer',
              border: `1px solid ${on ? T.ink : C.border}`,
              background: on ? T.ink : T.card,
            }}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: T.radius.pill,
                background: on ? p.color : 'transparent',
                border: `1px solid ${on ? 'rgba(255,255,255,0.75)' : T.etch}` }} />
              <span style={{ fontFamily: C.mono, fontSize: 11, fontWeight: 500, color: on ? T.white : T.etch, letterSpacing: '0.08em' }}>
                {p.label}{p.unit ? ` ${p.unit}` : ''}
              </span>
            </button>
          )
        })}
      </div>

      {/* Chart */}
      <canvas
        ref={canvasRef}
        onMouseDown={handleMouseDown}
        style={{ width: '100%', height, display: 'block', cursor: 'ew-resize' }}
      />
    </div>
  )
}
