import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../firebase/config'
import AircraftPhoto from '../components/aircraft/AircraftPhoto'
import useFleet from '../hooks/useFleet'
import { useClub } from '../contexts/ClubContext'
import {
  T, labelStyle, monoStyle, StatusDot, Button, Banner, Skeleton,
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
// Donnée absente = « −−− » (convention DS). Vitesse en kt, comme la donnée source.

function fmtDuration(startTs) {
  if (!startTs) return null
  const ms = Date.now() - (startTs?.toMillis?.() ?? startTs)
  const s  = Math.floor(ms / 1000)
  const h  = Math.floor(s / 3600)
  const m  = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${String(m).padStart(2,'0')}m` : `${m}m`
}

// ─── (21/09) Mise en page en 3 COLONNES (demande Christophe) : In flight · On ground · Unknown ──────────
// In flight = cartes ENCRE (chiffres live toujours visibles, comme les cartes métriques du DS) ;
// On ground / Unknown = cartes blanches compactes. LTE lost reste dans « In flight » (avion probablement
// toujours en l'air), avec un point ambre. Aucune couleur hors statut ; chiffres en Geist Mono.

function liveFigures(ac) {
  const live = ac.liveData, fdr = ac.fdrData
  return {
    altFt:  live?.altitude ?? (fdr?.alt != null ? fdr.alt * 3.28084 : null),   // SafeSky en ft ; FDR en m
    spdKt:  live?.speed    ?? fdr?.spd ?? null,
    hdgDeg: live?.heading  ?? fdr?.hdg ?? null,
    source: ac.status === 'LTE_LOST' ? 'FDR only' : live ? 'SafeSky' : fdr ? 'FDR' : '−−−',
  }
}
const ident = (ac) => ac.callSign || ac.registration || '−−−'
// (21/09) Étiquettes CLUB / OWNER conservées ; pour un avion privé, le nom du propriétaire s'ajoute.
const ownerOf = (ac, owners) => (ac.ownership === 'owner' && ac.ownerPilotId) ? (owners[ac.ownerPilotId] || null) : null

function Figure({ label, value }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={labelStyle(T.mutedDark)}>{label}</span>
      <span style={{ ...monoStyle(22, T.white), fontWeight: 500, letterSpacing: '-0.03em', lineHeight: 1 }}>{value}</span>
    </div>
  )
}

function FlyingCard({ ac, owner, onLocate }) {
  const st = STATUS[ac.status] ?? STATUS.IN_FLIGHT
  const f = liveFigures(ac)
  const dur = fmtDuration(ac.flightStart ?? null)
  const [alt, altU] = f.altFt  != null ? [String(Math.round(f.altFt)), 'FT'] : ['−−−', 'FT']
  const [spd, spdU] = f.spdKt  != null ? [String(Math.round(f.spdKt)), 'KT'] : ['−−−', 'KT']
  const hdg = f.hdgDeg != null ? String(Math.round(f.hdgDeg)).padStart(3, '0') : '−−−'
  return (
    <div style={{ background: T.ink, color: T.white, borderRadius: T.radius.md, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
        <AircraftPhoto ac={ac} width={64} height={48} onInk />
        <div style={{ minWidth: 0 }}>
          <div style={{ ...monoStyle(18, T.white), fontWeight: 500 }}>{ident(ac)}</div>
          <div style={{ ...monoStyle(11, T.mutedDark), marginTop: 3 }}>
            {ac.typeDesig || ac.type || '−−−'} · {ac.ownership === 'owner' ? 'OWNER' : 'CLUB'}{owner ? <span style={{ fontFamily: T.sans, fontSize: 12, color: T.white }}> · {owner}</span> : null}
          </div>
        </div>
        </div>
        {dur && <span style={{ ...monoStyle(18, T.white), fontWeight: 500 }}>{dur}</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
        <Figure label={`ALT ${altU}`} value={alt} />
        <Figure label={`GS ${spdU}`}  value={spd} />
        <Figure label="HDG"           value={hdg} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, borderTop: `1px solid ${T.ruleDark}`, paddingTop: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <StatusDot tone={st.tone} text={st.label} onInk />
          <span style={{ fontFamily: T.sans, fontSize: 13, color: T.white, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ac.pilotName || 'Pilot unknown'} <span style={{ ...monoStyle(11, T.mutedDark) }}>· {f.source}</span>
          </span>
        </div>
        {ac.liveData?.lat != null && (
          <Button size="sm" icon="map" onInk onClick={() => onLocate(ac.liveData.lat, ac.liveData.lon)} title="Show on live map">Map</Button>
        )}
      </div>
    </div>
  )
}

function ParkedCard({ ac, owner, muted }) {
  return (
    <div style={{ background: T.card, border: T.border, borderRadius: T.radius.md, padding: '12px 14px',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      <AircraftPhoto ac={ac} width={56} height={42} />
      <div style={{ minWidth: 0 }}>
        <div style={{ ...monoStyle(15, muted ? T.graphite : T.ink), fontWeight: 500 }}>{ident(ac)}</div>
        <div style={{ ...monoStyle(11, T.etch), marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {(ac.typeDesig || ac.type || '−−−')}{ac.pilotName ? ` · ${ac.pilotName}` : ''}
        </div>
      </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, maxWidth: '60%', minWidth: 0 }}>
        {owner && (
          <span title="Owner" style={{ fontFamily: T.sans, fontSize: 13, color: T.ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{owner}</span>
        )}
        <span style={{ ...labelStyle(T.graphite), padding: '2px 6px', borderRadius: T.radius.sm, border: T.border, flexShrink: 0 }}>
          {ac.ownership === 'owner' ? 'OWNER' : 'CLUB'}
        </span>
      </div>
    </div>
  )
}

function Column({ title, tone, live, items, empty, children }) {
  return (
    <section aria-label={title} style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}>
      <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', paddingBottom: 10, borderBottom: T.border }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={labelStyle(T.etch)}>{title}</span>
          <StatusDot tone={items.length ? tone : 'off'} text={items.length ? live : 'NONE'} />
        </div>
        <span style={{ ...monoStyle(40, items.length ? T.ink : T.etch), fontWeight: 500, letterSpacing: '-0.04em', lineHeight: 1 }}>{items.length}</span>
      </header>
      {items.length === 0
        ? <div style={{ fontFamily: T.sans, fontSize: 13, color: T.graphite, padding: '14px 2px' }}>{empty}</div>
        : children}
    </section>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function EnVolPage() {
  const { clubId } = useClub()
  const { fleet, loading, error } = useFleet(clubId)
  const navigate = useNavigate()
  const handleLocate = (lat, lon) => navigate('/live', { state: { flyTo: { lat, lon, zoom: 13 } } })
  const [owners, setOwners] = useState({})   // pilotId → « Prénom Nom » (propriétaires d'avions privés)
  useEffect(() => {
    if (!clubId) return
    getDocs(query(collection(db, 'pilots'), where('clubId', '==', clubId)))
      .then(snap => { const m = {}; snap.docs.forEach(d => { const p = d.data(); m[d.id] = [p.firstName, p.lastName].filter(Boolean).join(' ') || p.trigram || '' }); setOwners(m) })
      .catch(err => console.warn('[InFlight] owners:', err?.message || err))
  }, [clubId])

  const byName = (a, b) => ident(a).localeCompare(ident(b))
  const inFlight = fleet.filter(a => a.status === 'IN_FLIGHT' || a.status === 'LTE_LOST')
    .sort((a, b) => (a.status === b.status ? byName(a, b) : a.status === 'IN_FLIGHT' ? -1 : 1))
  const grounded = fleet.filter(a => a.status === 'GROUNDED').sort(byName)
  const unknown  = fleet.filter(a => a.status === 'UNKNOWN').sort(byName)

  return (
    <div style={{ width: '100%', height: '100%', background: T.paper, fontFamily: T.sans, color: T.ink, overflowY: 'auto' }}>
      <div style={{ padding: '28px 24px 40px', display: 'flex', flexDirection: 'column', gap: 22 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, fontFamily: T.sans, fontWeight: 600, fontSize: 28, letterSpacing: '-0.02em' }}>In flight</h1>
          <span style={{ ...monoStyle(12, T.etch) }}>{fleet.length} AIRCRAFT · REFRESH 5 S</span>
        </div>

        {error && <Banner tone="caution" title="Fleet unavailable">{error.message}</Banner>}

        {loading ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 22 }} aria-label="Loading fleet">
            {[0, 1, 2].map(i => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <Skeleton width={90} height={10} /><Skeleton height={120} radius={6} /><Skeleton height={56} radius={6} />
              </div>
            ))}
          </div>
        ) : !error && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 22, alignItems: 'start' }}>
            <Column title="IN FLIGHT" tone="ok" live="LIVE" items={inFlight} empty="No aircraft in flight.">
              {inFlight.map(ac => <FlyingCard key={ac.id} ac={ac} owner={ownerOf(ac, owners)} onLocate={handleLocate} />)}
            </Column>
            <Column title="ON GROUND" tone="off" live="PARKED" items={grounded} empty="No aircraft on the ground.">
              {grounded.map(ac => <ParkedCard key={ac.id} ac={ac} owner={ownerOf(ac, owners)} />)}
            </Column>
            <Column title="UNKNOWN" tone="caution" live="NO RECENT SIGNAL" items={unknown} empty="Every aircraft is reporting.">
              {unknown.map(ac => <ParkedCard key={ac.id} ac={ac} owner={ownerOf(ac, owners)} muted />)}
            </Column>
          </div>
        )}
      </div>
    </div>
  )
}
