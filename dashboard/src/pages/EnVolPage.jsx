import { useState, useEffect } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { db, auth } from '../firebase/config'
import useFleet from '../hooks/useFleet'

// ─── Design tokens (cohérent avec AerotraceMap) ───────────────────────────────
const C = {
  bg:         '#050814',
  panel:      'rgba(5,8,20,0.82)',
  border:     'rgba(255,255,255,0.07)',
  amber:      '#F5A623',
  amber10:    'rgba(245,166,35,0.10)',
  amber20:    'rgba(245,166,35,0.20)',
  amber40:    'rgba(245,166,35,0.40)',
  green:      '#22c55e',
  green10:    'rgba(34,197,94,0.10)',
  red:        '#ef4444',
  red10:      'rgba(239,68,68,0.10)',
  orange:     '#f97316',
  orange10:   'rgba(249,115,22,0.10)',
  text:       'rgba(255,255,255,0.88)',
  textMid:    'rgba(255,255,255,0.45)',
  textLow:    'rgba(255,255,255,0.22)',
  mono:       'monospace',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function fmtAlt(ft)  { return ft != null ? `${Math.round(ft)} ft` : '— ft' }
function fmtSpd(kt)  { return kt != null ? `${Math.round(kt)} kt` : '— kt' }
function fmtHdg(deg) { return deg != null ? `${Math.round(deg)}°` : '—°' }

function fmtDuration(startTs) {
  if (!startTs) return null
  const start = startTs?.toMillis?.() ?? startTs
  const secs  = Math.floor((Date.now() - start) / 1000)
  const h     = Math.floor(secs / 3600)
  const m     = Math.floor((secs % 3600) / 60)
  const s     = secs % 60
  return h > 0
    ? `${h}h${String(m).padStart(2,'0')}`
    : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
}

const STATUS_CONFIG = {
  IN_FLIGHT: { label: 'EN VOL',      color: C.green,  bg: C.green10,  dot: C.green,  pulse: true  },
  LTE_LOST:  { label: 'LTE PERDU',   color: C.orange, bg: C.orange10, dot: C.orange, pulse: true  },
  GROUNDED:  { label: 'AU SOL',      color: C.textLow,bg: 'transparent', dot: 'rgba(255,255,255,0.15)', pulse: false },
  UNKNOWN:   { label: 'INCONNU',     color: C.textLow,bg: 'transparent', dot: 'rgba(255,255,255,0.1)',  pulse: false },
}

// ─── Composants ──────────────────────────────────────────────────────────────

function StatusBadge({ status }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.UNKNOWN
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 8px', borderRadius: 4,
      background: cfg.bg,
      border: `1px solid ${cfg.color}30`,
    }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: cfg.dot, flexShrink: 0,
        boxShadow: cfg.pulse ? `0 0 8px ${cfg.dot}` : 'none',
        animation: cfg.pulse ? 'blink 2s ease-in-out infinite' : 'none',
      }} />
      <span style={{ fontFamily: C.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em', color: cfg.color }}>
        {cfg.label}
      </span>
    </div>
  )
}

function DataCell({ label, value, accent = false }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontFamily: C.mono, fontSize: 8, color: C.textLow, letterSpacing: '0.08em' }}>{label}</span>
      <span style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 700, color: accent ? C.amber : C.text }}>
        {value ?? '—'}
      </span>
    </div>
  )
}

// Barre latérale gauche collapsible — même style que AerotraceMap
function SidePanel({ title, open, onToggle, children }) {
  return (
    <div style={{
      background: C.panel, borderRadius: 10,
      border: `0.5px solid ${C.border}`, overflow: 'hidden',
      width: 200, flexShrink: 0,
    }}>
      <div
        onClick={onToggle}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '7px 10px', cursor: 'pointer', userSelect: 'none',
        }}
      >
        <span style={{ fontSize: 10, fontWeight: 700, fontFamily: C.mono, letterSpacing: '0.15em', color: C.text }}>
          {title}
        </span>
        <span style={{
          fontSize: 8, color: C.textLow, display: 'inline-block',
          transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s',
        }}>▶</span>
      </div>
      {open && <div style={{ padding: '0 8px 8px' }}>{children}</div>}
    </div>
  )
}

// Carte appareil en vol
function AircraftCard({ ac, expanded, onToggle }) {
  const cfg  = STATUS_CONFIG[ac.status] ?? STATUS_CONFIG.UNKNOWN
  const live = ac.liveData
  const fdr  = ac.fdrData
  const dur  = fmtDuration(ac.flightStart)
  const inFlight = ac.status === 'IN_FLIGHT' || ac.status === 'LTE_LOST'

  return (
    <div
      onClick={onToggle}
      style={{
        borderRadius: 8, overflow: 'hidden', cursor: 'pointer',
        border: `1px solid ${inFlight ? `${cfg.color}30` : C.border}`,
        background: inFlight ? `${cfg.color}08` : 'rgba(255,255,255,0.02)',
        transition: 'all 0.2s',
      }}
    >
      {/* Ligne principale */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px' }}>

        {/* Icône avion */}
        <div style={{
          width: 36, height: 36, borderRadius: 8, flexShrink: 0,
          background: inFlight ? C.amber10 : 'rgba(255,255,255,0.04)',
          border: `1px solid ${inFlight ? C.amber20 : C.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18,
          transform: live?.heading != null ? `rotate(${live.heading}deg)` : 'none',
          transition: 'transform 0.5s ease',
        }}>
          {ac.type === 'helicopter' ? '🚁' : '✈'}
        </div>

        {/* Infos principales */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontFamily: C.mono, fontSize: 14, fontWeight: 700, color: C.text }}>
              {ac.registration}
            </span>
            <span style={{ fontFamily: C.mono, fontSize: 10, color: C.textMid }}>
              {ac.type}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <StatusBadge status={ac.status} />
            {dur && inFlight && (
              <span style={{ fontFamily: C.mono, fontSize: 9, color: C.amber, letterSpacing: '0.06em' }}>
                ⏱ {dur}
              </span>
            )}
          </div>
        </div>

        {/* Altitude + Vitesse (si en vol) */}
        {inFlight && live && (
          <div style={{ display: 'flex', gap: 16, flexShrink: 0 }}>
            <DataCell label="ALT" value={fmtAlt(live.altitude)} accent />
            <DataCell label="SPD" value={fmtSpd(live.speed)} />
          </div>
        )}

        {/* Chevron expand */}
        <span style={{
          fontSize: 8, color: C.textLow, transition: 'transform 0.2s',
          transform: expanded ? 'rotate(90deg)' : 'none',
          flexShrink: 0, marginLeft: 4,
        }}>▶</span>
      </div>

      {/* Détails expandés */}
      {expanded && (
        <div style={{
          borderTop: `1px solid ${C.border}`,
          padding: '10px 12px',
          display: 'flex', flexDirection: 'column', gap: 10,
        }}>

          {/* Pilote */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: C.mono, fontSize: 9, color: C.textLow, letterSpacing: '0.08em' }}>PILOTE</span>
            <span style={{ fontFamily: C.mono, fontSize: 11, color: ac.pilotName ? C.text : C.textLow }}>
              {ac.pilotName ?? 'Non assigné'}
            </span>
          </div>

          {/* Données live SafeSky */}
          {live && (
            <div>
              <div style={{ fontFamily: C.mono, fontSize: 8, color: C.amber, letterSpacing: '0.1em', marginBottom: 8 }}>
                ◉ SAFESKY LIVE
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <DataCell label="ALTITUDE" value={fmtAlt(live.altitude)} accent />
                <DataCell label="VITESSE"  value={fmtSpd(live.speed)} />
                <DataCell label="CAP"      value={fmtHdg(live.heading)} />
              </div>
            </div>
          )}

          {/* Données FDR */}
          {fdr && (
            <div>
              <div style={{ fontFamily: C.mono, fontSize: 8, color: C.textMid, letterSpacing: '0.1em', marginBottom: 8 }}>
                ◈ FDR BOÎTIER
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <DataCell label="MODE"     value={fdr.mode?.replace('MODE_', '')} />
                <DataCell label="RPM"      value={fdr.rpm != null ? `${fdr.rpm}` : null} />
                <DataCell label="CO PPM"   value={fdr.co  != null ? `${fdr.co}` : null}
                  accent={fdr.co > 50} />
              </div>
              {fdr.co > 50 && (
                <div style={{
                  marginTop: 8, padding: '6px 8px', borderRadius: 6,
                  background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)',
                  fontFamily: C.mono, fontSize: 10, color: C.red, letterSpacing: '0.08em',
                }}>
                  ⚠ ALERTE CO — {fdr.co} PPM
                </div>
              )}
            </div>
          )}

          {/* LTE perdu */}
          {ac.status === 'LTE_LOST' && (
            <div style={{
              padding: '6px 8px', borderRadius: 6,
              background: C.orange10, border: `1px solid ${C.orange}40`,
              fontFamily: C.mono, fontSize: 10, color: C.orange, letterSpacing: '0.06em',
            }}>
              ⚡ Signal LTE perdu — dernier point connu affiché
            </div>
          )}

          {/* ICAO24 */}
          <div style={{ fontFamily: C.mono, fontSize: 9, color: C.textLow }}>
            ICAO24 : {ac.icao24 ?? '—'} · CALLSIGN : {ac.callSign ?? '—'}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Compteur animé en haut ───────────────────────────────────────────────────
function StatBar({ inFlight, grounded, unknown, total }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 24,
      padding: '12px 20px',
      borderBottom: `1px solid ${C.border}`,
      background: 'rgba(5,8,20,0.6)',
      flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: C.mono, fontSize: 28, fontWeight: 700, color: C.green,
          textShadow: `0 0 20px ${C.green}60` }}>
          {inFlight}
        </span>
        <span style={{ fontFamily: C.mono, fontSize: 10, color: C.textMid }}>EN VOL</span>
      </div>

      <div style={{ width: 1, height: 30, background: C.border }} />

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: C.mono, fontSize: 28, fontWeight: 700, color: C.textMid }}>
          {grounded}
        </span>
        <span style={{ fontFamily: C.mono, fontSize: 10, color: C.textLow }}>AU SOL</span>
      </div>

      <div style={{ width: 1, height: 30, background: C.border }} />

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontFamily: C.mono, fontSize: 28, fontWeight: 700, color: C.textLow }}>
          {total}
        </span>
        <span style={{ fontFamily: C.mono, fontSize: 10, color: C.textLow }}>APPAREILS</span>
      </div>

      <div style={{ flex: 1 }} />

      {/* Refresh indicator */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.green,
          animation: 'blink 2s ease-in-out infinite', boxShadow: `0 0 6px ${C.green}` }} />
        <span style={{ fontFamily: C.mono, fontSize: 9, color: C.textLow, letterSpacing: '0.08em' }}>
          LIVE · 5s
        </span>
      </div>
    </div>
  )
}

// ─── Page principale ──────────────────────────────────────────────────────────
export default function EnVolPage({ role }) {
  // TODO : récupérer clubId depuis le profil user Firestore
  // Pour l'instant : hardcodé en attendant la collection /clubs
  const CLUB_ID = 'club_aerobelgique'

  const { fleet, inFlight, grounded, unknown, loading, error } = useFleet(CLUB_ID)

  const [expandedId,   setExpandedId]   = useState(null)
  const [filterStatus, setFilterStatus] = useState('ALL')   // ALL | IN_FLIGHT | GROUNDED
  const [panelOpen,    setPanelOpen]    = useState({ filters: true })

  const toggleExpand = (id) => setExpandedId(prev => prev === id ? null : id)

  const filtered = fleet.filter(ac => {
    if (filterStatus === 'ALL')       return true
    if (filterStatus === 'IN_FLIGHT') return ac.status === 'IN_FLIGHT' || ac.status === 'LTE_LOST'
    if (filterStatus === 'GROUNDED')  return ac.status === 'GROUNDED'
    return true
  })

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', background: C.bg, fontFamily: C.mono,
      color: C.textLow, letterSpacing: '0.15em', fontSize: 11 }}>
      CHARGEMENT FLOTTE...
    </div>
  )

  if (error) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', background: C.bg, fontFamily: C.mono, color: C.red, fontSize: 11 }}>
      Erreur : {error.message}
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, overflow: 'hidden' }}>

      <style>{`
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>

      {/* Barre statistiques */}
      <StatBar
        inFlight={inFlight.length}
        grounded={grounded.length}
        unknown={unknown.length}
        total={fleet.length}
      />

      {/* Corps principal */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Sidebar gauche — filtres (style AerotraceMap) */}
        <div style={{ padding: '12px 0 12px 12px', display: 'flex', flexDirection: 'column', gap: 4, zIndex: 10 }}>

          <SidePanel
            title="FILTRES"
            open={panelOpen.filters}
            onToggle={() => setPanelOpen(p => ({ ...p, filters: !p.filters }))}
          >
            {[
              { id: 'ALL',       label: 'TOUS',    count: fleet.length },
              { id: 'IN_FLIGHT', label: 'EN VOL',  count: inFlight.length },
              { id: 'GROUNDED',  label: 'AU SOL',  count: grounded.length },
            ].map(f => {
              const active = filterStatus === f.id
              return (
                <div
                  key={f.id}
                  onClick={() => setFilterStatus(f.id)}
                  style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    padding: '4px 6px', borderRadius: 6, cursor: 'pointer', userSelect: 'none',
                    marginBottom: 2,
                    background: active ? 'rgba(245,166,35,0.08)' : 'rgba(255,255,255,0.02)',
                    borderLeft: `2px solid ${active ? C.amber : 'rgba(255,255,255,0.07)'}`,
                  }}
                >
                  <span style={{ fontFamily: C.mono, fontSize: 9, fontWeight: 500,
                    color: active ? C.text : C.textLow, letterSpacing: '0.05em' }}>
                    {f.label}
                  </span>
                  <span style={{ fontFamily: C.mono, fontSize: 9, color: active ? C.amber : C.textLow }}>
                    {f.count}
                  </span>
                </div>
              )
            })}
          </SidePanel>
        </div>

        {/* Liste appareils */}
        <div style={{
          flex: 1, overflowY: 'auto', padding: 12,
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {filtered.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '100%', fontFamily: C.mono, fontSize: 11, color: C.textLow,
              letterSpacing: '0.1em' }}>
              AUCUN APPAREIL
            </div>
          ) : (
            filtered.map(ac => (
              <AircraftCard
                key={ac.id}
                ac={ac}
                expanded={expandedId === ac.id}
                onToggle={() => toggleExpand(ac.id)}
              />
            ))
          )}
        </div>
      </div>
    </div>
  )
}
