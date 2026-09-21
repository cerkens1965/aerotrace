// Chip — étiquette bordée Geist Mono 10 px (22/09, sortie d'Admin / Fleet / Logbook) : licences, CLUB / OWNER,
// ARCHIVED, versions. strong = bord encre ; muted = texte etch ; tone = point de statut devant (ok | caution | info | off).
// Jamais de couleur de texte : la couleur n'est portée que par le point. Écrire le texte en capitales soi-même.
import { T } from './tokens'
import StatusDot from './StatusDot'

export default function Chip({ children, tone, strong = false, muted = false, onInk = false, title, style }) {
  const text = muted ? T.etch : strong ? (onInk ? T.white : T.ink) : (onInk ? T.mutedDark : T.graphite)
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, height: 20, padding: '0 6px', whiteSpace: 'nowrap',
      border: `1px solid ${strong ? (onInk ? T.white : T.ink) : (onInk ? T.ruleDark : T.rule)}`, borderRadius: T.radius.sm,
      background: onInk ? T.ink : T.card, color: text,
      fontFamily: T.mono, fontSize: 10, fontWeight: 500, letterSpacing: '0.06em', fontVariantNumeric: 'tabular-nums', ...style,
    }}>
      {tone && <StatusDot tone={tone} size={6} />}
      {children}
    </span>
  )
}
