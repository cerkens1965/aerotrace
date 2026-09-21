// Banner — bannière inline (erreur réseau, info, succès) avec « Retry » optionnel.
// Règles DS : fond carte, bordure 1 px rule + bord gauche 3 px de la couleur du ton ; tones info | caution | ok ;
// JAMAIS de rouge (une erreur récupérable = caution) ; le texte reste encre/graphite, jamais ambre.
import { T } from './tokens'
import Button from './Button'

const TONES = { info: T.info, caution: T.amber, ok: T.ok }

export default function Banner({ tone = 'info', title, children, onRetry, retryLabel = 'Retry', action, style }) {
  return (
    <div
      role={tone === 'caution' ? 'alert' : 'status'}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
        background: T.card, borderTop: T.border, borderRight: T.border, borderBottom: T.border, borderLeft: `3px solid ${TONES[tone] || TONES.info}`,
        borderRadius: T.radius.sm, padding: '10px 12px', ...style,
      }}
    >
      <div style={{ flex: '1 1 200px', minWidth: 0, fontFamily: T.sans, fontSize: 13, lineHeight: 1.5 }}>
        {title && <div style={{ fontWeight: 600, color: T.ink }}>{title}</div>}
        {children && <div style={{ color: T.graphite }}>{children}</div>}
      </div>
      {action}
      {onRetry && <Button size="sm" icon="refresh" onClick={onRetry}>{retryLabel}</Button>}
    </div>
  )
}
