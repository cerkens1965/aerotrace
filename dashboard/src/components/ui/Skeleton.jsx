// Skeleton — barre de chargement (remplace les spinners).
// Règles DS : barres rule sur carte (ou paper via tone="paper"), radius 3, pulsation d'opacité douce
// 1,6 s, coupée si prefers-reduced-motion. Pas de dégradé « shimmer », pas d'ombre.
import { T } from './tokens'
import { ensureAirKiStyles } from './styles'

ensureAirKiStyles()

export default function Skeleton({ width = '100%', height = 12, radius = 3, tone = 'rule', style }) {
  return (
    <span
      aria-hidden="true"
      className="ak-skeleton"
      style={{
        display: 'block', width, height, borderRadius: radius,
        background: tone === 'paper' ? T.paper : T.rule, ...style,
      }}
    />
  )
}
