import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import useFleet from '../hooks/useFleet'
import { useClub } from '../contexts/ClubContext'

// ─── Design tokens — WHITE theme (matches LogbookPage) ───────────────────────
const C = {
  bg:      '#f4f5f7',
  surface: '#ffffff',
  border:  'rgba(10,14,30,0.10)',
  text:    '#0a0e1e',
  mid:     'rgba(10,14,30,0.55)',
  low:     'rgba(10,14,30,0.35)',
  mono:    'monospace',
  green:   '#22c55e',
  green10: 'rgba(34,197,94,0.10)',
  green20: 'rgba(34,197,94,0.20)',
  amber:   '#F5A623',
  amber10: 'rgba(245,166,35,0.10)',
  amber20: 'rgba(245,166,35,0.20)',
  red:     '#ef4444',
  red10:   'rgba(239,68,68,0.10)',
  orange:  '#f97316',
  orange10:'rgba(249,115,22,0.10)',
}

// ─── Status config ────────────────────────────────────────────────────────────
const STATUS = {
  IN_FLIGHT: { label: 'IN FLIGHT', color: '#22c55e', bg: 'rgba(34,197,94,0.10)',  pulse: true  },
  LTE_LOST:  { label: 'LTE LOST',  color: '#f97316', bg: 'rgba(249,115,22,0.10)', pulse: true  },
  GROUNDED:  { label: 'GROUNDED',  color: 'rgba(10,14,30,0.4)', bg: 'transparent', pulse: false },
  UNKNOWN:   { label: 'UNKNOWN',   color: 'rgba(10,14,30,0.25)', bg: 'transparent', pulse: false },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmtAlt = ft  => ft  != null ? `${Math.round(ft)} ft` : '—'
const fmtSpd = kt  => kt  != null ? `${Math.round(kt)} kt` : '—'
const fmtHdg = deg => deg != null ? `${Math.round(deg)}°`  : '—'

function fmtDuration(startTs) {
  if (!startTs) return null
  const ms = Date.now() - (startTs?.toMillis?.() ?? startTs)
  const s  = Math.floor(ms / 1000)
  const h  = Math.floor(s / 3600)
  const m  = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m`
}

// ─── StatBar ─────────────────────────────────────────────────────────────────
function StatBar({ fleet }) {
  const inFlight = fleet.filter(a => a.status === 'IN_FLIGHT' || a.status === 'LTE_LOST').length
  const grounded = fleet.filter(a => a.status === 'GROUNDED').length

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 36,
      padding: '16px 28px',
      borderBottom: `1px solid ${C.border}`,
      background: C.surface, flexShrink: 0,
    }}>
      <Stat value={inFlight} label="IN FLIGHT" color={C.green} />
      <div style={{ width: 1, height: 36, background: C.border }} />
      <Stat value={grounded} label="GROUNDED"  color={C.text} />
      <div style={{ width: 1, height: 36, background: C.border }} />
      <Stat value={fleet.length} label="AIRCRAFT" color={C.mid} />
      <div style={{ flex: 1 }} />
      {/* Live pulse */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{
          width: 7, height: 7, borderRadius: '50%', background: C.green,
          boxShadow: `0 0 8px ${C.green}`,
          animation: 'if-blink 2s ease-in-out infinite',
        }} />
        <span style={{ fontFamily: C.mono, fontSize: 9, letterSpacing: '0.1em', color: C.mid }}>LIVE · 5s</span>
      </div>

      <style>{`
        @keyframes if-blink  { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes if-pulse  { 0%{box-shadow:0 0 0 0 rgba(34,197,94,0.5)} 70%{box-shadow:0 0 0 7px rgba(34,197,94,0)} 100%{box-shadow:0 0 0 0 rgba(34,197,94,0)} }
        @keyframes if-spin   { to{transform:rotate(360deg)} }
      `}</style>
    </div>
  )
}

function Stat({ value, label, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <span style={{ fontFamily: C.mono, fontSize: 38, fontWeight: 700, color }}>{value}</span>
      <span style={{ fontFamily: C.mono, fontSize: 10, letterSpacing: '0.12em', color: C.mid }}>{label}</span>
    </div>
  )
}

// ─── Filter tab ───────────────────────────────────────────────────────────────
function FilterTab({ label, count, active, color, onClick }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 7,
      padding: '6px 14px', borderRadius: 7, cursor: 'pointer',
      border: `1px solid ${active ? color : C.border}`,
      background: active ? `${color}15` : 'transparent',
      transition: 'all 0.15s',
    }}>
      <span style={{ fontFamily: C.mono, fontSize: 10, fontWeight: 700,
        letterSpacing: '0.08em', color: active ? color : C.mid }}>{label}</span>
      <span style={{
        fontFamily: C.mono, fontSize: 10, fontWeight: 700,
        color: active ? color : C.low,
        background: active ? `${color}20` : C.bg,
        padding: '1px 7px', borderRadius: 4,
      }}>{count}</span>
    </button>
  )
}

// ─── Aircraft card ────────────────────────────────────────────────────────────
function AircraftCard({ ac, expanded, onToggle, onLocate }) {
  const st  = STATUS[ac.status] ?? STATUS.UNKNOWN
  const dur = fmtDuration(ac.flightStart ?? null)

  // SafeSky d'abord, fallback FDR. SafeSky est en ft/kt/deg ; FDR alt est en mètres.
  const live = ac.liveData
  const fdr  = ac.fdrData
  const altFt  = live?.altitude ?? (fdr?.alt != null ? fdr.alt * 3.28084 : null)
  const spdKt  = live?.speed    ?? fdr?.spd ?? null
  const hdgDeg = live?.heading  ?? fdr?.hdg ?? null
  const sourceLabel = ac.status === 'LTE_LOST' ? 'FDR only'
    : live ? 'SafeSky'
    : fdr  ? 'FDR'
    : '—'

  return (
    <div style={{
      background: C.surface,
      border: `1px solid ${ac.status === 'IN_FLIGHT' ? 'rgba(34,197,94,0.30)' : C.border}`,
      borderRadius: 10, overflow: 'hidden',
      boxShadow: ac.status === 'IN_FLIGHT' ? '0 2px 12px rgba(34,197,94,0.08)' : 'none',
      transition: 'box-shadow 0.2s',
    }}>

      {/* Header row — clickable */}
      <div onClick={onToggle} style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '14px 20px', cursor: 'pointer',
        background: ac.status === 'IN_FLIGHT' ? 'rgba(34,197,94,0.05)' : 'transparent',
      }}>
        {/* Status dot */}
        <span style={{
          width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
          background: st.color,
          animation: st.pulse ? 'if-pulse 2s infinite' : 'none',
        }} />

        {/* Registration + type */}
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ fontFamily: C.mono, fontSize: 15, fontWeight: 700, color: C.text }}>
              {ac.callSign || ac.registration}
            </span>
            <span style={{
              fontFamily: C.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.05em', padding: '2px 6px', borderRadius: 4,
              background: ac.ownership === 'owner' ? 'rgba(96,165,250,0.12)' : 'rgba(239,68,68,0.12)',
              color: ac.ownership === 'owner' ? '#60a5fa' : '#ef4444',
              border: `1px solid ${ac.ownership === 'owner' ? 'rgba(96,165,250,0.4)' : 'rgba(239,68,68,0.4)'}`,
            }}>{ac.ownership === 'owner' ? 'OWNER' : 'CLUB'}</span>
          </div>
          <div style={{ fontFamily: C.mono, fontSize: 10, color: C.mid, marginTop: 2 }}>
            {ac.typeDesig || ac.type || '—'}
          </div>
        </div>

        {/* Duration */}
        {dur && (
          <span style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 700, color: C.green }}>
            {dur}
          </span>
        )}

        {/* Locate button */}
        {ac.liveData?.lat != null && (
          <button
            onClick={e => { e.stopPropagation(); onLocate(ac.liveData.lat, ac.liveData.lon) }}
            title="Show on live map"
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${C.amber}`, background: C.amber10,
              fontFamily: C.mono, fontSize: 10, fontWeight: 700,
              letterSpacing: '0.05em', color: C.amber,
              transition: 'all 0.15s', flexShrink: 0,
            }}
          >
            ◎ MAP
          </button>
        )}

        {/* Status badge */}
        <span style={{
          fontFamily: C.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
          color: st.color, background: st.bg,
          padding: '3px 10px', borderRadius: 5,
          border: `1px solid ${st.color}44`,
        }}>{st.label}</span>

        {/* Chevron */}
        <span style={{
          color: C.low, fontSize: 12,
          transform: expanded ? 'rotate(180deg)' : 'none',
          transition: 'transform 0.2s',
        }}>▾</span>
      </div>

      {/* Expanded detail grid */}
      {expanded && (
        <div style={{
          borderTop: `1px solid ${C.border}`,
          padding: '16px 20px',
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 14,
          background: '#fafbfc',
        }}>
          {[
            { label: 'ALTITUDE', value: fmtAlt(altFt) },
            { label: 'SPEED',    value: fmtSpd(spdKt) },
            { label: 'HEADING',  value: fmtHdg(hdgDeg) },
            { label: 'PILOT',    value: ac.pilotName ?? '—' },
            { label: 'SOURCE',   value: sourceLabel },
            { label: 'ICAO24',   value: ac.icao24 ?? '—' },
          ].map(({ label, value }) => (
            <div key={label}>
              <div style={{ fontFamily: C.mono, fontSize: 9, letterSpacing: '0.12em', color: C.low, marginBottom: 4 }}>
                {label}
              </div>
              <div style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 700, color: C.text }}>
                {value}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function EnVolPage({ role }) {
  const { clubId } = useClub()
  const { fleet, loading, error } = useFleet(clubId)
  const navigate = useNavigate()

  const [expanded, setExpanded] = useState(null)
  const [filter,   setFilter]   = useState('ALL')

  const handleLocate = (lat, lon) => {
    navigate('/live', { state: { flyTo: { lat, lon, zoom: 13 } } })
  }

  const inFlight = fleet.filter(a => a.status === 'IN_FLIGHT' || a.status === 'LTE_LOST')
  const grounded = fleet.filter(a => a.status === 'GROUNDED')
  const unknown  = fleet.filter(a => a.status === 'UNKNOWN')

  const filtered = filter === 'ALL'       ? fleet
    : filter === 'IN_FLIGHT' ? inFlight
    : filter === 'GROUNDED'  ? grounded
    : unknown

  const sorted = [...filtered].sort((a, b) => {
    const order = { IN_FLIGHT: 0, LTE_LOST: 1, GROUNDED: 2, UNKNOWN: 3 }
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status]
    return (a.callSign || a.registration || '').localeCompare(b.callSign || b.registration || '')
  })

  return (
    <div style={{
      width: '100%', height: '100%', background: C.bg,
      display: 'flex', flexDirection: 'column',
      fontFamily: C.mono, overflow: 'hidden',
    }}>

      {/* Stat bar */}
      {!loading && !error && <StatBar fleet={fleet} />}

      {/* Filter toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '12px 24px',
        borderBottom: `1px solid ${C.border}`,
        background: C.surface, flexShrink: 0,
      }}>
        <FilterTab label="ALL"       count={fleet.length}    active={filter==='ALL'}       color={C.text}  onClick={() => setFilter('ALL')} />
        <FilterTab label="IN FLIGHT" count={inFlight.length} active={filter==='IN_FLIGHT'} color={C.green} onClick={() => setFilter('IN_FLIGHT')} />
        <FilterTab label="GROUNDED"  count={grounded.length} active={filter==='GROUNDED'}  color={C.mid}   onClick={() => setFilter('GROUNDED')} />
        {unknown.length > 0 && (
          <FilterTab label="UNKNOWN" count={unknown.length}  active={filter==='UNKNOWN'}   color={C.low}   onClick={() => setFilter('UNKNOWN')} />
        )}
      </div>

      {/* Fleet list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: 200 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              border: `2px solid ${C.border}`,
              borderTop: `2px solid ${C.amber}`,
              animation: 'if-spin 0.8s linear infinite',
            }} />
          </div>
        )}

        {error && (
          <div style={{
            background: C.red10, border: `1px solid rgba(239,68,68,0.3)`,
            borderRadius: 8, padding: '14px 18px',
            color: C.red, fontSize: 12, fontFamily: C.mono,
          }}>
            Fleet error: {error.message}
          </div>
        )}

        {!loading && !error && sorted.length === 0 && (
          <div style={{ textAlign: 'center', color: C.low, fontSize: 12, marginTop: 60 }}>
            No aircraft found for this club.
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 820 }}>
          {sorted.map(ac => (
            <AircraftCard
              key={ac.id}
              ac={ac}
              expanded={expanded === ac.id}
              onToggle={() => setExpanded(p => p === ac.id ? null : ac.id)}
              onLocate={handleLocate}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
