// Field — libellé de champ + contrôle + aide optionnelle (22/09, sorti d'Admin / Fleet).
// Libellé Geist Mono 10 px capitales (écrire la chaîne en capitales soi-même), aide Instrument Sans 12 graphite.
// Rend un <label> : cliquer le libellé donne le focus au contrôle qu'il contient.
import { T, labelStyle } from './tokens'

export default function Field({ label, hint, onInk = false, children, style }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, ...style }}>
      {label != null && <span style={labelStyle(onInk ? T.mutedDark : T.etch)}>{label}</span>}
      {children}
      {hint && <span style={{ fontFamily: T.sans, fontSize: 12, lineHeight: 1.4, color: onInk ? T.mutedDark : T.graphite }}>{hint}</span>}
    </label>
  )
}
