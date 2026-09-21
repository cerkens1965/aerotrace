// FleetStrip — bandeau « flotte » au-dessus de la carte Live (2026-09-21).
// Même source que la page In flight (useFleet) → Live et In flight disent TOUJOURS la même chose.
// Remplace « No aircraft in flight », qui se basait sur le trafic de la zone visible et pouvait être faux.
//   ● n in flight  REG · REG   ○ n on ground   ● n not reporting
// Clic sur une immatriculation → onLocate(lat, lon) centre la carte. Clic sur « in flight » → page In flight.
// Survol : répartition club / owner. DS : panneau encre, bord 1 px #2C2C2C, chiffres Geist Mono, jamais de rouge.
import { useNavigate } from 'react-router-dom'
import useFleet from '../../hooks/useFleet'
import { T, monoStyle, labelStyle } from '../ui'

const ident = (a) => a.callSign || a.registration || '?'
const posOf = (a) => {
  const l = a.liveData, f = a.fdrData
  if (l?.lat != null && l?.lon != null) return { lat: l.lat, lon: l.lon }
  if (f?.lat != null && f?.lon != null) return { lat: f.lat, lon: f.lon }
  return null
}
const split = (list) => {
  const own = list.filter(a => a.ownership === 'owner').length
  return `${list.length - own} club · ${own} owner`
}
const Dot = ({ c }) => <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 999, background: c, flexShrink: 0 }} />

export default function FleetStrip({ clubId, onLocate }) {
  const navigate = useNavigate()
  const { fleet, inFlight, grounded, unknown, loading, error } = useFleet(clubId)
  if (!clubId) return null

  const wrap = {
    position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 11,
    maxWidth: 'calc(100% - 24px)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', justifyContent: 'center',
    background: T.ink, border: `1px solid ${T.ruleDark}`, borderRadius: 6, padding: '8px 14px',
    fontFamily: T.sans, fontSize: 13, color: T.white,
  }
  const seg = { display: 'flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }
  const num = { ...monoStyle(15, T.white), fontWeight: 500 }
  const btn = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'inherit' }

  if (loading) return <div role="status" style={wrap}><span style={labelStyle(T.mutedDark)}>FLEET</span><span style={{ color: T.mutedDark }}>Loading…</span></div>
  if (error)   return <div role="status" style={wrap}><span style={labelStyle(T.mutedDark)}>FLEET</span><Dot c={T.amber} /><span>Fleet status unavailable</span></div>
  if (!fleet.length) return null

  const lte = inFlight.filter(a => a.status === 'LTE_LOST').length
  return (
    <div role="status" aria-live="polite" style={wrap}>
      <span style={labelStyle(T.mutedDark)}>FLEET</span>

      <span style={seg} title={inFlight.length ? `${split(inFlight)}${lte ? ` · ${lte} with LTE lost` : ''}` : undefined}>
        <Dot c={inFlight.length ? T.ok : T.etch} />
        <button type="button" style={btn} onClick={() => navigate('/in-flight')} title="Open In flight">
          <span style={num}>{inFlight.length}</span> in flight
        </button>
        {inFlight.map(a => {
          const p = posOf(a)
          return (
            <button key={a.id} type="button" disabled={!p}
              onClick={() => p && onLocate?.({ ...p, zoom: 12 })}
              title={p ? `Show ${ident(a)} on the map` : `${ident(a)}: no position yet`}
              style={{ ...btn, ...monoStyle(13, p ? T.white : T.mutedDark), fontWeight: 500, textDecoration: p ? 'underline' : 'none',
                       textUnderlineOffset: 3, textDecorationColor: T.ruleDark, cursor: p ? 'pointer' : 'default' }}>
              {a.status === 'LTE_LOST' && <Dot c={T.amber} />} {ident(a)}
            </button>
          )
        })}
      </span>

      <span style={seg} title={grounded.length ? split(grounded) : undefined}>
        <Dot c={T.etch} /><span style={num}>{grounded.length}</span> on ground
      </span>

      {unknown.length > 0 && (
        <span style={seg} title={`${unknown.map(ident).join(' · ')} — no position or status received recently`}>
          <Dot c={T.amber} /><span style={num}>{unknown.length}</span> not reporting
        </span>
      )}
    </div>
  )
}
