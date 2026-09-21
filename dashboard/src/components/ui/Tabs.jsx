// Tabs — onglets segmentés (remplace les deux TabBtn).
// Règles DS : Instrument Sans Semibold 13 px, pas de text-transform ; bordure 1 px, radius 4 ;
// sur papier : actif = fond encre / texte blanc, inactif = graphite ; sur encre (onInk) : actif = blanc /
// texte encre, inactif = #9A9A94. Compteur en Geist Mono tabulaire. Clavier : flèches ←/→, Début/Fin.
// tabs : [{ key, label, count? }] ; value = key actif ; onChange(key).
import { useRef, useState } from 'react'
import { T } from './tokens'
import { ensureAirKiStyles } from './styles'

ensureAirKiStyles()

export default function Tabs({ tabs = [], value, onChange, onInk = false, ariaLabel, style }) {
  const refs = useRef([])
  const [hover, setHover] = useState(null)

  const move = (idx) => {
    const n = tabs.length
    if (!n) return
    const i = (idx + n) % n
    refs.current[i]?.focus()
    onChange?.(tabs[i].key)
  }

  const onKeyDown = (e, i) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); move(i + 1) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); move(i - 1) }
    else if (e.key === 'Home') { e.preventDefault(); move(0) }
    else if (e.key === 'End') { e.preventDefault(); move(tabs.length - 1) }
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      style={{
        display: 'inline-flex', flexWrap: 'wrap', gap: 2, padding: 2,
        border: onInk ? T.borderDark : T.border, borderRadius: T.radius.sm,
        background: onInk ? T.ink : T.card, ...style,
      }}
    >
      {tabs.map((t, i) => {
        const active = t.key === value
        const fg = active ? (onInk ? T.ink : T.white) : (onInk ? T.mutedDark : T.graphite)
        const bg = active ? (onInk ? T.white : T.ink) : (hover === t.key ? (onInk ? T.ruleDark : T.paper) : 'transparent')
        return (
          <button
            key={t.key}
            ref={(el) => { refs.current[i] = el }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active || (value == null && i === 0) ? 0 : -1}
            className="ak-focus"
            onClick={() => onChange?.(t.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
            onMouseEnter={() => setHover(t.key)}
            onMouseLeave={() => setHover(null)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, padding: '0 12px',
              border: 'none', borderRadius: 3, background: bg, color: fg, cursor: 'pointer',
              fontFamily: T.sans, fontWeight: 600, fontSize: 13, letterSpacing: '-0.01em', whiteSpace: 'nowrap',
            }}
          >
            {t.label}
            {t.count != null && (
              <span style={{
                fontFamily: T.mono, fontSize: 11, fontWeight: 500, fontVariantNumeric: 'tabular-nums',
                color: active ? (onInk ? T.graphite : T.mutedDark) : T.etch,
              }}>
                {t.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
