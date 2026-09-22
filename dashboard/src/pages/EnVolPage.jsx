// In flight — tableau de bord instructeur (22/09, d'après Claude Design « In flight board », export AirKi Dashboard-2).
// « Qui vole, tout va bien ?, qui est au sol, quel boîtier se tait. » Live répond « où », In flight répond « qui et comment ».
// En-tête (titre 28 + méta mono · Refresh · Open Live map) → bannière si données périmées → 4 MetricCard →
// sections Airborne (cartes détaillées) · On the ground (cartes compactes + dernier vol) · Silent boxes (dernier signal).
// Données réelles : useFleet (statut, chiffres live, fix), useOwnerNames, dernier vol par avion lu dans /flights.
// Règles DS : jamais de rouge, ambre jamais en texte, chiffres Geist Mono, « −−− » si absent, bord 1 px, aucune ombre.
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../firebase/config'
import AircraftPhoto from '../components/aircraft/AircraftPhoto'
import useFleet from '../hooks/useFleet'
import useOwnerNames, { ownerOf } from '../hooks/useOwnerNames'
import { useClub } from '../contexts/ClubContext'
import { tsMillis } from '../utils/logbookUtils'
import {
  T, labelStyle, monoStyle, headingStyle, StatusDot, Button, Banner, Skeleton, MetricCard, EmptyState, Chip,
} from '../components/ui'

const MISSING = '−−−'
const STALE_S = 40            // données plus vieilles que 40 s → bannière « last known values »
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

const ident = (ac) => ac.callSign || ac.registration || MISSING
const byName = (a, b) => ident(a).localeCompare(ident(b))
const pad2 = (n) => String(n).padStart(2, '0')
const hhmm = (ms) => { const m = Math.max(0, Math.floor(ms / 60000)); return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}` }
const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}` }
const utcHM = (t) => { const d = new Date(t); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` }
const dayLabel = (t, now) => {
  const d = new Date(t), n = new Date(now)
  if (d.toISOString().slice(0, 10) === n.toISOString().slice(0, 10)) return 'TODAY'
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`
}
const startMs = (ac) => (ac.flightStart ? tsMillis(ac.flightStart) : 0)

// Dernier vol connu par avion (clé = immat ou indicatif en capitales), lu une fois dans /flights du club.
function useLastFlights(clubId) {
  const [last, setLast] = useState({})
  useEffect(() => {
    if (!clubId) return
    let on = true
    getDocs(query(collection(db, 'flights'), where('clubId', '==', clubId)))
      .then(snap => {
        const m = {}
        snap.docs.forEach(d => {
          const f = d.data()
          if (f.archived) return
          const k = String(f.aircraftIdent || '').toUpperCase()
          const t = tsMillis(f.startTs)
          if (k && t && (!m[k] || t > m[k].t)) m[k] = { t, dur: Number(f.duration) || 0 }
        })
        if (on) setLast(m)
      })
      .catch(err => console.warn('[InFlight] last flights:', err?.message || err))
    return () => { on = false }
  }, [clubId])
  return last
}

// Horloge de la page (5 s) : durées, âges, péremption — sans Date.now() pendant le rendu.
function useNow(periodMs = 5000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), periodMs); return () => clearInterval(t) }, [periodMs])
  return now
}

function Figure({ label, value }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span style={labelStyle(T.etch)}>{label}</span>
      <span style={{ ...monoStyle(22, value === MISSING ? T.etch : T.ink), fontWeight: 500, letterSpacing: '-0.02em', lineHeight: 1 }}>{value}</span>
    </div>
  )
}

function SectionHead({ title, meta }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, paddingBottom: 8, borderBottom: T.border }}>
      <h2 style={{ ...headingStyle(15), margin: 0 }}>{title}</h2>
      <span style={labelStyle(T.etch)}>{meta}</span>
    </div>
  )
}

function OwnerTag({ ac, owner, muted }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <Chip muted={muted}>{ac.ownership === 'owner' ? 'OWNER' : 'CLUB'}</Chip>
      {owner && <span style={{ fontFamily: T.sans, fontSize: 12, color: T.graphite, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{owner}</span>}
    </span>
  )
}

const cardBox = { background: T.card, border: T.border, borderRadius: T.radius.md }
const innerRule = '1px solid #EDE9E2'

function AirborneCard({ ac, owner, now, onLocate }) {
  const l = ac.liveData, f = ac.fdrData
  const lte = ac.status === 'LTE_LOST'
  const pos = l?.lat != null ? { lat: l.lat, lon: l.lon } : (f?.lat != null ? { lat: f.lat, lon: f.lon } : null)
  let alt = MISSING, gs = MISSING, hdg = MISSING, source, statusText
  if (lte) {
    const silent = f?.lastSeen ? now - f.lastSeen : 0
    statusText = `LTE LOST · ${Math.max(1, Math.round(silent / 60000))} MIN`
    const lastAlt = f?.alt != null ? `${Math.round(f.alt * 3.28084)} FT` : null
    const lastGs = f?.spd != null ? `${Math.round(f.spd)} KT` : null
    source = `AIRKI CORE ONLY${lastAlt || lastGs ? ` · LAST ${[lastAlt, lastGs].filter(Boolean).join(' / ')}` : ''}${f?.lastSeen ? `, ${mmss(silent)} AGO` : ''}`
  } else {
    statusText = 'IN FLIGHT · LIVE'
    const a = l?.altitude ?? (f?.alt != null ? f.alt * 3.28084 : null)
    const s = l?.speed ?? f?.spd ?? null
    const h = l?.heading ?? f?.hdg ?? null
    if (a != null) alt = String(Math.round(a))
    if (s != null) gs = String(Math.round(s))
    if (h != null) hdg = String(Math.round(h) % 360).padStart(3, '0')
    const age = l?.fixTs ? Math.max(0, Math.round((now - l.fixTs) / 1000)) : null
    source = l ? `SAFESKY NETWORK${age != null ? ` · ${age} S AGO` : ''}` : 'AIRKI CORE'
  }
  const since = startMs(ac) ? hhmm(now - startMs(ac)) : MISSING
  return (
    <article style={{ ...cardBox, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <AircraftPhoto ac={ac} width={72} height={54} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
            <span style={{ ...monoStyle(15, T.ink), fontWeight: 500, letterSpacing: '0.04em' }}>{ident(ac)}</span>
            <OwnerTag ac={ac} owner={owner} />
          </div>
          <StatusDot tone={lte ? 'caution' : 'ok'} text={statusText} />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, paddingTop: 12, borderTop: innerRule }}>
        <Figure label="ALT FT" value={alt} />
        <Figure label="GS KT" value={gs} />
        <Figure label="HDG" value={hdg} />
      </div>
      <div style={labelStyle(T.etch)}>{source}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 12, borderTop: innerRule, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
          <span style={{ fontFamily: T.sans, fontSize: 13, color: T.ink }}>{ac.pilotName || 'Pilot unknown'}</span>
          <span style={labelStyle(T.etch)}>AIRBORNE {since}</span>
        </div>
        <Button size="sm" icon="map" disabled={!pos} onClick={() => pos && onLocate(pos)} title={pos ? 'Centre the Live map on this aircraft' : 'No position yet'}>
          Show on map
        </Button>
      </div>
    </article>
  )
}

function CompactCard({ ac, owner, tone, text, note }) {
  return (
    <div style={{ ...cardBox, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      <AircraftPhoto ac={ac} width={40} height={30} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', minWidth: 0 }}>
          <span style={{ ...monoStyle(13, T.ink), fontWeight: 500, letterSpacing: '0.04em' }}>{ident(ac)}</span>
          <OwnerTag ac={ac} owner={owner} muted />
        </div>
        <StatusDot tone={tone} text={text} />
      </div>
      {note && <span style={{ ...labelStyle(T.etch), textAlign: 'right', maxWidth: 130 }}>{note}</span>}
    </div>
  )
}

const SkeletonCard = () => (
  <div style={{ ...cardBox, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
    <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
      <Skeleton width={72} height={54} radius={4} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}><Skeleton width={84} height={14} /><Skeleton width={130} height={10} /></div>
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, paddingTop: 12, borderTop: innerRule }}>
      <Skeleton height={28} /><Skeleton height={28} /><Skeleton height={28} />
    </div>
    <Skeleton width="60%" height={10} />
  </div>
)

export default function EnVolPage() {
  const { clubId } = useClub()
  const { fleet, loading, error, updatedAt, refresh } = useFleet(clubId)
  const owners = useOwnerNames(clubId)
  const lastFlights = useLastFlights(clubId)
  const now = useNow()
  const navigate = useNavigate()
  const locate = (p) => navigate('/live', { state: { flyTo: { ...p, zoom: 13 } } })

  const flying = useMemo(() => fleet.filter(a => a.status === 'IN_FLIGHT' || a.status === 'LTE_LOST')
    .sort((a, b) => (a.status === b.status ? byName(a, b) : a.status === 'IN_FLIGHT' ? -1 : 1)), [fleet])
  const grounded = useMemo(() => fleet.filter(a => a.status === 'GROUNDED').sort(byName), [fleet])
  const silent = useMemo(() => fleet.filter(a => a.status === 'UNKNOWN').sort(byName), [fleet])

  const n = fleet.length
  const live = flying.filter(a => a.status === 'IN_FLIGHT').length
  const lte = flying.length - live
  const longest = flying.filter(startMs).sort((a, b) => startMs(a) - startMs(b))[0] || null
  const staleS = updatedAt ? Math.round((now - updatedAt) / 1000) : null
  const stale = !loading && !error && staleS != null && staleS > STALE_S

  const lastNote = (ac) => {
    const lf = lastFlights[String(ac.callSign || '').toUpperCase()] || lastFlights[String(ac.registration || '').toUpperCase()]
    return lf ? `LAST FLIGHT ${dayLabel(lf.t, now)} · ${hhmm(lf.dur * 1000)}` : 'NO FLIGHT LOGGED'
  }
  const silentNote = (ac) => (ac.fdrData?.lastSeen
    ? `NO DATA SINCE ${dayLabel(ac.fdrData.lastSeen, now)} · ${utcHM(ac.fdrData.lastSeen)}`
    : 'NO DATA RECEIVED')

  const refreshing = { tone: 'off', text: 'Refreshing' }
  const grid = (min) => ({ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: 12 })

  return (
    <div style={{ width: '100%', height: '100%', background: T.paper, fontFamily: T.sans, color: T.ink, overflowY: 'auto' }}>
      <main style={{ padding: '28px 32px 48px', display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 1400 }}>
        <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <h1 style={{ ...headingStyle(28), margin: 0 }}>In flight</h1>
            <div style={labelStyle(T.etch)}>
              FLEET OF {loading ? MISSING : n} · AUTO-REFRESH 5 S · UPDATED {updatedAt ? `${utcHM(updatedAt)} UTC` : MISSING}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Button size="sm" icon="refresh" onClick={refresh}>Refresh</Button>
            <Button size="sm" icon="map" onClick={() => navigate('/live')}>Open Live map</Button>
          </div>
        </header>

        {error && (
          <Banner tone="caution" title="Fleet unavailable" onRetry={refresh}>
            {error.message || 'The fleet list could not be read.'}
          </Banner>
        )}
        {stale && (
          <Banner tone="caution" title="Fleet unavailable" onRetry={refresh} retryLabel="Retry">
            The fleet status could not be refreshed for {staleS} s. The figures below are the last known values.
          </Banner>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10 }}>
          <MetricCard label="IN FLIGHT" value={loading ? null : String(flying.length)}
            status={loading ? refreshing : flying.length
              ? { tone: lte ? 'caution' : 'ok', text: [live && `${live} live`, lte && `${lte} LTE lost`].filter(Boolean).join(' · ') }
              : { tone: 'off', text: 'Fleet on the ground' }} />
          <MetricCard label="ON GROUND" value={loading ? null : String(grounded.length)} status={loading ? refreshing : { tone: 'off', text: 'Parked' }} />
          <MetricCard label="NO SIGNAL" value={loading ? null : String(silent.length)}
            status={loading ? refreshing : silent.length ? { tone: 'caution', text: 'Check the unit' } : { tone: 'ok', text: 'All reporting' }} />
          <MetricCard label="LONGEST AIRBORNE" value={loading ? null : longest ? hhmm(now - startMs(longest)) : MISSING}
            status={loading ? refreshing : longest ? { tone: 'ok', text: ident(longest) } : { tone: 'off', text: 'Nothing airborne' }} />
        </div>

        <section aria-label="Airborne" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SectionHead title="Airborne" meta={loading ? MISSING : `${flying.length} OF ${n}`} />
          {loading ? (
            <div style={grid(330)}><SkeletonCard /><SkeletonCard /></div>
          ) : flying.length === 0 ? (
            <div style={{ ...cardBox, padding: 8 }}>
              <EmptyState text="No aircraft in flight. The whole fleet is on the ground."
                action={<Button size="sm" icon="list" onClick={() => navigate('/logbook')}>Open logbook</Button>} />
            </div>
          ) : (
            <div style={grid(330)}>
              {flying.map(ac => <AirborneCard key={ac.id} ac={ac} owner={ownerOf(ac, owners)} now={now} onLocate={locate} />)}
            </div>
          )}
        </section>

        {!loading && grounded.length > 0 && (
          <section aria-label="On the ground" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <SectionHead title="On the ground" meta={`${grounded.length} OF ${n}`} />
            <div style={grid(280)}>
              {grounded.map(ac => <CompactCard key={ac.id} ac={ac} owner={ownerOf(ac, owners)} tone="off" text="ON GROUND" note={lastNote(ac)} />)}
            </div>
          </section>
        )}

        {!loading && silent.length > 0 && (
          <section aria-label="Silent boxes" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <SectionHead title="Silent boxes" meta="NO SIGNAL · CHECK THE UNIT" />
            <div style={grid(280)}>
              {silent.map(ac => <CompactCard key={ac.id} ac={ac} owner={ownerOf(ac, owners)} tone="caution" text="NO SIGNAL" note={silentNote(ac)} />)}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}
