// EmptyState — état vide : une phrase en graphite, une action optionnelle (remplace les alert() et
// les pages blanches). Règles DS : Instrument Sans 14 px, pas d'illustration ni d'emoji, pas de capitales.
// action : nœud libre, ou raccourci actionLabel + onAction (bouton secondaire sm).
import { T } from './tokens'
import Button from './Button'

export default function EmptyState({ text, children, action, actionLabel, onAction, style }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', gap: 12,
      padding: '28px 16px', textAlign: 'center', ...style,
    }}>
      <span style={{ fontFamily: T.sans, fontSize: 14, lineHeight: 1.5, color: T.graphite }}>{text ?? children}</span>
      {action ?? (actionLabel && onAction && <Button size="sm" onClick={onAction}>{actionLabel}</Button>)}
    </div>
  )
}
