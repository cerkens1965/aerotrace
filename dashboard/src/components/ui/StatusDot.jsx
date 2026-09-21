// StatusDot — point de statut 8 px + texte mono 11 px optionnel.
// Règle DS : vert confirme (ok), ambre transitoire (caution), bleu information (info), gris etch éteint (off).
// JAMAIS de rouge sur un statut. La couleur n'est portée que par le point, jamais par le texte
// (ambre interdit en texte) : le texte est graphite sur papier, #9A9A94 sur encre (onInk).
import { T } from './tokens'

const TONES = { ok: T.ok, caution: T.amber, info: T.info, off: T.etch }

export default function StatusDot({ tone = 'off', text, onInk = false, size = 8, style }) {
  const color = TONES[tone] || TONES.off
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, ...style }}>
      <span aria-hidden="true" style={{ width: size, height: size, borderRadius: T.radius.pill, background: color, flexShrink: 0 }} />
      {text != null && (
        <span style={{
          fontFamily: T.mono, fontSize: 11, fontWeight: 500, letterSpacing: '0.02em', lineHeight: 1.2,
          fontVariantNumeric: 'tabular-nums', color: onInk ? T.mutedDark : T.graphite,
        }}>
          {text}
        </span>
      )}
    </span>
  )
}
