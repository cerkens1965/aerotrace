// FleetStrip — bandeau « flotte » au-dessus de la carte Live (21/09, redessiné 22/09 d'après Claude Design « Live »).
// Données fournies par LivePage (useFleet, même source que In flight) → Live et In flight disent la même chose.
//   FLEET  ● 2 IN FLIGHT  FJFVB · FJVUD  |  ● 4 ON GROUND  |  ● 1 NOT REPORTING
// Clic immat = centre la carte ; clic « IN FLIGHT » = page In flight ; survol = répartition club / owner.
// DS : panneau encre, bord 1 px #2C2C2C, chiffres Geist Mono, soulignement ambre au survol, jamais de rouge.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { T, monoStyle, labelStyle, StatusDot } from '../ui'
import { posOf } from './fleetPos'

const ident = (a) => a.callSign || a.registration || '?'
const split = (list) => {
  const own = list.filter(a => a.ownership === 'owner').length
  return `${list.length - own} club · ${own} owner`
}
const btn = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', color: 'inherit' }
const Sep = () => <span aria-hidden="true" style={{ width: 1, height: 16, background: T.ruleDark, flexShrink: 0 }} />

function RegLink({ ac, onLocate }) {
  const [hover, setHover] = useState(false)
  const p = posOf(ac)
  return (
    <button type="button" className="ak-focus" disabled={!p}
      onClick={() => p && onLocate?.({ ...p, zoom: 12 })}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      title={p ? `Show ${ident(ac)} on the map` : `${ident(ac)}: no position yet`}
      style={{ ...btn, ...monoStyle(12, p ? T.white : T.mutedDark), fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 5,
               borderBottom: `1px solid ${hover && p ? T.amber : T.ruleDark}`, cursor: p ? 'pointer' : 'default' }}>
      {ac.status === 'LTE_LOST' && <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: T.amber }} />}
      {ident(ac)}
    </button>
  )
}

export default function FleetStrip({ fleet = [], inFlight = [], grounded = [], unknown = [], loading, error, onLocate }) {
  const navigate = useNavigate()
  const wrap = {
    pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', justifyContent: 'center',
    background: T.ink, border: `1px solid ${T.ruleDark}`, borderRadius: 6, padding: '10px 18px', maxWidth: '100%',
  }
  if (loading) return <div role="status" style={wrap}><span style={labelStyle(T.mutedDark)}>FLEET</span><StatusDot tone="off" onInk text="LOADING…" /></div>
  if (error)   return <div role="status" style={wrap}><span style={labelStyle(T.mutedDark)}>FLEET</span><StatusDot tone="caution" onInk text="FLEET STATUS UNAVAILABLE" /></div>
  if (!fleet.length) return null

  const lte = inFlight.filter(a => a.status === 'LTE_LOST').length
  return (
    <div role="status" aria-live="polite" style={wrap}>
      <span style={labelStyle(T.mutedDark)}>FLEET</span>

      <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
            title={inFlight.length ? `${split(inFlight)}${lte ? ` · ${lte} with LTE lost` : ''}` : undefined}>
        <button type="button" className="ak-focus" style={btn} onClick={() => navigate('/in-flight')} title="Open In flight">
          <StatusDot tone={inFlight.length ? 'ok' : 'off'} onInk text={`${inFlight.length} IN FLIGHT`} />
        </button>
        {inFlight.length > 0 && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {inFlight.map((a, i) => (
              <span key={a.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                {i > 0 && <span aria-hidden="true" style={monoStyle(12, T.etch)}>·</span>}
                <RegLink ac={a} onLocate={onLocate} />
              </span>
            ))}
          </span>
        )}
      </span>

      <Sep />
      <span title={grounded.length ? split(grounded) : undefined}>
        <StatusDot tone="off" onInk text={`${grounded.length} ON GROUND`} />
      </span>

      {unknown.length > 0 && (<>
        <Sep />
        <span title={`${unknown.map(ident).join(' · ')}: no position or status received recently`}>
          <StatusDot tone="caution" onInk text={`${unknown.length} NOT REPORTING`} />
        </span>
      </>)}
    </div>
  )
}
