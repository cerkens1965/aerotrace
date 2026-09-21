// LiveInFlightPanel — panneau « In flight » à droite de la carte Live (22/09, d'après Claude Design « Live »).
// 320 px, encre, bord gauche 1 px ; repliable en rail 44 px (chevron). Une carte par avion en vol :
// photo 56×42, immat mono 15 + LIVE / LTE LOST, « type · CLUB » ou « type · OWNER · nom », ALT FT / GS KT / HDG
// en mono 16, pied « pilote · durée HH:MM ». Clic sur la carte = centre la carte sur l'avion.
// Vide : EmptyState « No aircraft in flight. » ; pied : « UPDATED 21 SEP 2026 · 14:32 UTC ».
import { useState } from 'react'
import AircraftPhoto from '../aircraft/AircraftPhoto'
import { ownerOf } from '../../hooks/useOwnerNames'
import { formatDateTime } from '../../utils/logbookUtils'
import { T, labelStyle, monoStyle, StatusDot, EmptyState, Icon, Skeleton } from '../ui'
import { posOf } from './fleetPos'

const ident = (a) => a.callSign || a.registration || '−−−'

function hhmm(startTs) {
  if (!startTs) return '−−:−−'
  const ms = Date.now() - (startTs?.toMillis?.() ?? Number(startTs))
  if (!(ms >= 0)) return '−−:−−'
  const m = Math.floor(ms / 60000)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

function figures(ac) {
  const l = ac.liveData, f = ac.fdrData
  const alt = l?.altitude ?? (f?.alt != null ? f.alt * 3.28084 : null)
  const gs  = l?.speed ?? f?.spd ?? null
  const hdg = l?.heading ?? f?.hdg ?? null
  return {
    alt: alt != null ? String(Math.round(alt)) : '−−−',
    gs:  gs  != null ? String(Math.round(gs))  : '−−−',
    hdg: hdg != null ? String(Math.round(hdg) % 360).padStart(3, '0') : '−−−',
  }
}

function Figure({ label, value }) {
  return (
    <div>
      <div style={labelStyle(T.mutedDark)}>{label}</div>
      <div style={{ ...monoStyle(16, value === '−−−' ? T.etch : T.white), fontWeight: 500, marginTop: 2 }}>{value}</div>
    </div>
  )
}

function FlightCard({ ac, owner, onLocate }) {
  const [hover, setHover] = useState(false)
  const p = posOf(ac)
  const f = figures(ac)
  const lte = ac.status === 'LTE_LOST'
  const sub = [ac.typeDesig || ac.type || '−−−', ac.ownership === 'owner' ? 'OWNER' : 'CLUB', owner].filter(Boolean).join(' · ')
  return (
    <button type="button" className="ak-focus" disabled={!p}
      onClick={() => p && onLocate({ ...p, zoom: 12 })}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      title={p ? `Show ${ident(ac)} on the map` : `${ident(ac)}: no position yet`}
      style={{ all: 'unset', boxSizing: 'border-box', display: 'block', width: '100%', cursor: p ? 'pointer' : 'default',
               border: `1px solid ${hover && p ? T.etch : T.ruleDark}`, borderRadius: 6, padding: 12 }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <AircraftPhoto ac={ac} width={56} height={42} onInk />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <span style={{ ...monoStyle(15, T.white), fontWeight: 500 }}>{ident(ac)}</span>
            <StatusDot tone={lte ? 'caution' : 'ok'} onInk text={lte ? 'LTE LOST' : 'LIVE'} />
          </div>
          <div style={{ fontFamily: T.sans, fontSize: 11, color: T.mutedDark, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 12 }}>
        <Figure label="ALT FT" value={f.alt} />
        <Figure label="GS KT" value={f.gs} />
        <Figure label="HDG" value={f.hdg} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${T.ruleDark}` }}>
        <span style={{ fontFamily: T.sans, fontSize: 11, color: T.mutedDark, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ac.pilotName || 'Pilot unknown'}</span>
        <span style={{ ...monoStyle(12, T.white), fontWeight: 500 }} title="Time since take-off">{hhmm(ac.flightStart)}</span>
      </div>
    </button>
  )
}

export default function LiveInFlightPanel({ inFlight = [], owners = {}, loading, error, updatedAt, trafficDown, open, onToggle, onLocate }) {
  const toggleBtn = (
    <button type="button" className="ak-focus" onClick={onToggle} title={open ? 'Collapse panel' : 'Show In flight panel'}
      aria-expanded={open}
      style={{ all: 'unset', cursor: 'pointer', display: 'flex', color: T.etch, transform: open ? 'none' : 'rotate(180deg)' }}>
      <Icon name="chevron-right" size={16} />
    </button>
  )

  if (!open) return (
    <aside aria-label="In flight" style={{ width: 44, flexShrink: 0, background: T.ink, borderLeft: `1px solid ${T.ruleDark}`,
                                            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, paddingTop: 16 }}>
      {toggleBtn}
      <span style={{ ...monoStyle(11, T.mutedDark) }}>{inFlight.length}</span>
      <span style={{ ...labelStyle(T.mutedDark), writingMode: 'vertical-rl' }}>IN FLIGHT</span>
    </aside>
  )

  const stamp = updatedAt ? formatDateTime(updatedAt).toUpperCase() : '−−−'
  return (
    <aside aria-label="In flight" style={{ width: 320, flexShrink: 0, background: T.ink, borderLeft: `1px solid ${T.ruleDark}`, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 16px 14px', borderBottom: `1px solid ${T.ruleDark}` }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontFamily: T.sans, fontSize: 14, color: T.white }}>In flight</span>
          <span style={monoStyle(11, T.mutedDark)}>{loading ? '−' : inFlight.length}</span>
        </div>
        {toggleBtn}
      </div>

      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', minHeight: 0 }}>
        {loading ? (
          <><Skeleton height={150} radius={6} /><Skeleton height={150} radius={6} /></>
        ) : error ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: T.sans, fontSize: 13, color: T.white, padding: '12px 2px' }}>
            <StatusDot tone="caution" /> Fleet status unavailable.
          </div>
        ) : inFlight.length === 0 ? (
          <EmptyState text={<span style={{ color: T.mutedDark }}>No aircraft in flight.</span>} />
        ) : (
          inFlight.map(ac => <FlightCard key={ac.id} ac={ac} owner={ownerOf(ac, owners)} onLocate={onLocate} />)
        )}
        {!loading && (
          <div style={{ ...labelStyle(T.etch), marginTop: 2, textAlign: inFlight.length ? 'left' : 'center' }}>
            {trafficDown ? `TRAFFIC −−− · FLEET ${stamp}` : `UPDATED ${stamp}`}
          </div>
        )}
      </div>
    </aside>
  )
}
