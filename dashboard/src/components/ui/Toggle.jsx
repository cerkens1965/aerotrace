// Toggle — bouton à bascule / segment (aria-pressed) (22/09, sorti d'Admin). Actif = fond encre, texte blanc ;
// inactif = carte blanche, bord rule, texte graphite. Mettre plusieurs Toggle côte à côte pour un choix segmenté.
import { T } from './tokens'
import { ensureAirKiStyles } from './styles'

ensureAirKiStyles()

export default function Toggle({ active = false, onClick, mono = false, disabled, title, children, style }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} disabled={disabled} title={title} className="ak-focus"
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        height: 28, padding: '0 10px', borderRadius: T.radius.sm, cursor: disabled ? 'default' : 'pointer',
        border: `1px solid ${active ? T.ink : T.rule}`, background: active ? T.ink : T.card,
        color: active ? T.white : T.graphite, opacity: disabled ? 0.5 : 1,
        fontFamily: mono ? T.mono : T.sans, fontSize: mono ? 11 : 13, fontWeight: mono ? 500 : 600,
        letterSpacing: mono ? '0.04em' : '-0.01em', whiteSpace: 'nowrap', ...style,
      }}>
      {children}
    </button>
  )
}
