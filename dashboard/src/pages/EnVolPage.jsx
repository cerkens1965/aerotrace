import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import useFleet from '../hooks/useFleet'
import { useClub } from '../contexts/ClubContext'
import {
  T, labelStyle, monoStyle, MetricCard, Tabs, StatusDot, Button, Icon, Banner, EmptyState, Skeleton,
} from '../components/ui'

// ─── Status config ────────────────────────────────────────────────────────────
// Règle DS : jamais de rouge ; la couleur n'est portée que par le point (StatusDot).
const STATUS = {
  IN_FLIGHT: { label: 'IN FLIGHT', tone: 'ok' },
  LTE_LOST:  { label: 'LTE LOST',  tone: 'caution' },
  GROUNDED:  { label: 'GROUNDED',  tone: 'off' },
  UNKNOWN:   { label: 'UNKNOWN',   tone: 'off' },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
// Donnée absente = « −−− » (convention DS). Vitesse affichée en kt, comme la donnée source.
const fmtAlt = ft  => ft  != null ? `${Math.round(ft)} ft` : '−−−'
const fmtSpd = kt  => kt  != null ? `${Math.round(kt)} kt` : '−−−'
const fmtHdg = deg => deg != null ? `${String(Math.round(deg)).padStart(3, '0')}°`  : '−−−'

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
    <div style={{ padding: '20px 24px 0', flexShrink: 0 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, maxWidth: 820 }}>
        <MetricCard label="IN FLIGHT" value={inFlight} status={{ tone: inFlight > 0 ? 'ok' : 'off', text: 'LIVE · 5S' }} />
        <MetricCard label="ON GROUND" value={grounded} />
        <MetricCard label="AIRCRAFT"  value={fleet.length} />
      </div>
    </div>
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
    : '−−−'

  return (
    <div style={{
      background: T.card, border: T.border, borderRadius: T.radius.md, overflow: 'hidden',
    }}>

      {/* Header row — clickable */}
      <div onClick={onToggle} style={{
        display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
        padding: '14px 18px', cursor: 'pointer',
      }}>
        {/* Registration + type */}
        <div style={{ flex: 1, minWidth: 140 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...monoStyle(15, T.ink), fontWeight: 500 }}>
              {ac.callSign || ac.registration}
            </span>
            <span style={{
              ...labelStyle(T.graphite), padding: '2px 6px', borderRadius: T.radius.sm, border: T.border,
            }}>{ac.ownership === 'owner' ? 'OWNER' : 'CLUB'}</span>
          </div>
          <div style={{ ...monoStyle(11, T.etch), marginTop: 3 }}>
            {ac.typeDesig || ac.type || '−−−'}
          </div>
        </div>

        {/* Duration */}
        {dur && (
          <span style={{ ...monoStyle(13, T.ink), fontWeight: 500 }}>
            {dur}
          </span>
        )}

        {/* Locate button */}
        {ac.liveData?.lat != null && (
          <Button
            size="sm" icon="map"
            onClick={e => { e.stopPropagation(); onLocate(ac.liveData.lat, ac.liveData.lon) }}
            title="Show on live map"
          >
            Show on map
          </Button>
        )}

        {/* Status */}
        <StatusDot tone={st.tone} text={st.label} style={{ minWidth: 88 }} />

        {/* Chevron */}
        <Icon name="chevron-right" size={16} color={T.etch}
          style={{ transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }} />
      </div>

      {/* Expanded detail grid */}
      {expanded && (
        <div style={{
          borderTop: T.border,
          padding: '16px 18px',
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 14,
          background: T.paper,
        }}>
          {[
            { label: 'ALTITUDE', value: fmtAlt(altFt),        mono: true },
            { label: 'SPEED',    value: fmtSpd(spdKt),        mono: true },
            { label: 'HEADING',  value: fmtHdg(hdgDeg),       mono: true },
            { label: 'PILOT',    value: ac.pilotName ?? '−−−' },
            { label: 'SOURCE',   value: sourceLabel },
            { label: 'ICAO24',   value: ac.icao24 ?? '−−−',   mono: true },
          ].map(({ label, value, mono }) => (
            <div key={label}>
              <div style={{ ...labelStyle(T.etch), marginBottom: 4 }}>
                {label}
              </div>
              <div style={mono
                ? { ...monoStyle(13, T.ink), fontWeight: 500 }
                : { fontFamily: T.sans, fontSize: 13, fontWeight: 500, color: T.ink }}>
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
      width: '100%', height: '100%', background: T.paper,
      display: 'flex', flexDirection: 'column',
      fontFamily: T.sans, color: T.ink, overflow: 'hidden',
    }}>

      {/* Stat bar */}
      {!loading && !error && <StatBar fleet={fleet} />}

      {/* Filter toolbar */}
      <div style={{ padding: '16px 24px 0', flexShrink: 0 }}>
        <Tabs
          ariaLabel="Filter aircraft"
          value={filter}
          onChange={setFilter}
          tabs={[
            { key: 'ALL',       label: 'All',       count: fleet.length },
            { key: 'IN_FLIGHT', label: 'In flight', count: inFlight.length },
            { key: 'GROUNDED',  label: 'Grounded',  count: grounded.length },
            ...(unknown.length > 0 ? [{ key: 'UNKNOWN', label: 'Unknown', count: unknown.length }] : []),
          ]}
        />
      </div>

      {/* Fleet list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>

        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 820 }} aria-label="Loading fleet">
            {[0, 1, 2].map(i => (
              <div key={i} style={{ background: T.card, border: T.border, borderRadius: T.radius.md, padding: '16px 18px',
                display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Skeleton width={120} height={14} />
                <Skeleton width={70} height={10} />
              </div>
            ))}
          </div>
        )}

        {error && (
          <Banner tone="caution" title="Fleet unavailable" style={{ maxWidth: 820 }}>
            {error.message}
          </Banner>
        )}

        {!loading && !error && sorted.length === 0 && (
          <EmptyState text="No aircraft found for this club." style={{ maxWidth: 820 }} />
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
