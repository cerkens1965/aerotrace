import { useParams } from 'react-router-dom'

export default function ReplayPage({ user, role }) {
  const { flightId } = useParams()

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      height: '100%', background: '#050814', gap: 16,
    }}>

      <div style={{
        width: 64, height: 64, borderRadius: 16,
        background: 'rgba(245,166,35,0.1)',
        border: '1px solid rgba(245,166,35,0.3)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontSize: 28, color: '#F5A623',
      }}>
        ▶
      </div>

      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 700,
          color: '#ffffff', letterSpacing: '0.15em' }}>
          REPLAY
        </span>
        <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'rgba(255,255,255,0.6)', letterSpacing: '0.08em' }}>
          À implémenter — prochaine session
        </span>
        {flightId && (
          <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#F5A623', marginTop: 8 }}>
            Vol : {flightId}
          </span>
        )}
      </div>

      <div style={{
        marginTop: 16, padding: '16px 24px', borderRadius: 10,
        background: 'rgba(255,255,255,0.03)',
        border: '1px solid rgba(255,255,255,0.1)',
        display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 360,
      }}>
        {[
          { icon: '◉', label: 'Trace 2D sur carte AIP' },
          { icon: '⏱', label: 'Timeline play / pause / scrub' },
          { icon: '◈', label: 'Six-pack instruments (ADI / badin…)' },
          { icon: '▤', label: '9 graphiques synchronisés' },
          { icon: '⚠', label: 'Alertes G / CO / trafic' },
          { icon: '⬡', label: 'Vue 3D cockpit (phase future)' },
          { icon: '📄', label: 'Export AIRPROX PDF' },
        ].map((f, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#F5A623', width: 16 }}>
              {f.icon}
            </span>
            <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#ffffff', letterSpacing: '0.04em' }}>
              {f.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
