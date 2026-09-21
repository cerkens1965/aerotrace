// MetricCard — tuile chiffrée sur encre (remplace StatCard du Logbook et tuiles Fleet).
// Règles DS : fond encre, radius 6, padding 16, pas d'ombre ; libellé Geist Mono 10 px 0.08em #9A9A94
// (écrire la chaîne en capitales, pas de text-transform) ; valeur Geist Mono 30 px blanc -0.04em tabulaire ;
// unité mono 10 px #9A9A94 ; donnée absente = « −−− » en etch, jamais un code ambre.
// status optionnel : { tone: 'ok' | 'caution' | 'off', text } rendu par StatusDot.
import { T, labelStyle, valueStyle } from './tokens'
import StatusDot from './StatusDot'

export default function MetricCard({ label, value, unit, status, style }) {
  const missing = value == null || value === ''
  return (
    <div style={{
      background: T.ink, color: T.white, borderRadius: T.radius.md, padding: 16,
      border: T.borderDark, display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, ...style,
    }}>
      {label != null && <div style={labelStyle(T.mutedDark)}>{label}</div>}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
        <span style={valueStyle(30, missing ? T.etch : T.white)}>{missing ? '−−−' : value}</span>
        {unit && !missing && <span style={labelStyle(T.mutedDark)}>{unit}</span>}
      </div>
      {status && <StatusDot tone={status.tone} text={status.text} onInk />}
    </div>
  )
}
