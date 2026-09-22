// src/pages/LogbookPage.jsx
// Logbook relationnel — LA liste de vols (Loop n'est plus que le lecteur d'un vol).
//   My flights   → vols du compte connecté, relié à sa fiche /pilots par e-mail
//                  (findMyPilot : uid posé par le code d'invitation, sinon e-mail). Seul onglet d'un pilote (rôle 'user') ;
//                  premier onglet des instructeurs/admins s'ils ont une fiche.
//   Pilots       → logbook par pilote/étudiant (heures, vols, instructeurs)
//   Instructors  → logbook par instructeur (heures instruites, élèves, présence)
//   Aircraft     → logbook par aéronef (heures, pilotes, utilisation)
//   All flights  → matrice admin filtrable (Qui-Quoi-Comment), assignation inline
// Vols lus en temps réel (onSnapshot), archivés (soft delete) exclus partout.
// Vol « To assign » = needsAssignment() (logbookUtils) : non validé, hors vol
// propriétaire déjà attribué. Les rendus utilisent f._pending, calculé une fois.
// (lot 02, 2026-09-21) Habillage AirKi : bibliothèque src/components/ui (T, MetricCard, Tabs,
// DataTable, Button, StatusDot, Banner, EmptyState, Icon). Logique inchangée. Libellés en
// capitales écrits dans la chaîne (aucun text-transform), pas de rouge, ambre jamais en texte.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { collection, getDocs, query, where, doc, updateDoc, addDoc, deleteDoc, onSnapshot, serverTimestamp } from 'firebase/firestore'
import { ref, uploadBytesResumable } from 'firebase/storage'
import { db, storage, auth } from '../firebase/config'
import { parseG3XCSV } from '../utils/csvParser'
import { useNavigate, useLocation } from 'react-router-dom'
import { useClub } from '../contexts/ClubContext'
import FlightAssignModal from '../components/logbook/FlightAssignModal'
import RedeemInvite from '../components/auth/RedeemInvite'
import {
  T, labelStyle, valueStyle, headingStyle, monoStyle,
  Button, MetricCard, StatusDot, DataTable, Tabs, Banner, EmptyState, Icon, Chip,
} from '../components/ui'
import {
  formatDate, formatDateTime, formatDuration, sortByDateDesc, tsMillis, icaoFlag, icaoCountry,
  FLIGHT_TYPES, getPilotName, sumDuration, flightTypeBadge, needsAssignment, findMyPilot,
} from '../utils/logbookUtils'

// Rôles autorisés à importer un CSV depuis le Logbook.
const IMPORT_ROLES = ['instructor', 'admin', 'super_admin']

// ─── Shared low-level components ──────────────────────────────────────────────

const DASH = <span style={{ color: T.etch }}>—</span>

// Point coloré 8 px (type de vol) — la couleur n'est portée que par le point.
function Dot({ color, size = 8 }) {
  return <span aria-hidden="true" style={{ width: size, height: size, borderRadius: T.radius.pill, background: color, flexShrink: 0 }} />
}

// Type de vol : point coloré + texte mono graphite (FLIGHT_TYPES n'a ni rouge ni texte ambre).
function TypeBadge({ type }) {
  const b = flightTypeBadge(type)
  if (!b) return DASH
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      <Dot color={b.color} />
      <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 500, letterSpacing: '0.02em', color: T.graphite }}>{b.label}</span>
    </span>
  )
}

function ValidBadge({ validated }) {
  return <StatusDot tone={validated ? 'ok' : 'caution'} text={validated ? 'VALIDATED' : 'TO ASSIGN'} style={{ whiteSpace: 'nowrap' }} />
}

/**
 * Terrain (OACI) + drapeau de son pays. `icao` null → tiret : normalizeFlight n'a
 * trouvé aucun terrain à moins de 5 km du 1er/dernier point GPS (hors base AIP, ou
 * log qui ne démarre pas au sol). On préfère l'aveu au terrain faux.
 * Le drapeau ne s'affiche pas sous Windows (pas de police) → les 2 lettres du pays
 * apparaissent à la place, ce qui reste lisible.
 */
function Airfield({ icao }) {
  if (!icao) return DASH
  const flag = icaoFlag(icao)
  return (
    <span title={icaoCountry(icao) || 'unknown country'} style={{ color: T.ink }}>
      {flag && <span style={{ marginRight: 4 }}>{flag}</span>}{icao}
    </span>
  )
}

function Route({ f }) {
  if (!(f.depIcao || f.arrIcao)) return DASH
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      <Airfield icao={f.depIcao} />
      <span style={{ color: T.etch }}> → </span>
      <Airfield icao={f.arrIcao} />
    </span>
  )
}

// G max : au-delà de 2.5 G, valeur en gras précédée d'un point ambre (statut, jamais du texte ambre ni rouge).
function GMax({ g }) {
  if (!g) return DASH
  const high = g > 2.5
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: high ? 600 : 400, color: high ? T.ink : T.graphite }}>
      {high && <Dot color={T.amber} />}
      {`${g.toFixed(1)}G`}
    </span>
  )
}

const presenceText = f => (f.instructorOnboard ? 'On board' : 'On ground')

// Boutons de ligne : Open Loop, Assign (vol en attente) / Edit (vol validé), Delete (admin, 2 temps).
function RowActions({ f, onReplay, onAssign, canDelete, onDelete }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end', whiteSpace: 'nowrap' }}>
      {/* (22/09) vol à attribuer : « Assign » EN PREMIER (il était poussé hors écran à droite) */}
      {onAssign && f._pending && <Button size="sm" variant="primary" icon="edit" onClick={() => onAssign(f)}>Assign</Button>}
      <Button size="sm" icon="play" onClick={() => onReplay(f.id)}>Open Loop</Button>
      {onAssign && !f._pending && <Button size="sm" variant="ghost" icon="edit" onClick={() => onAssign(f)} title="Edit assignment">Edit</Button>}
      {canDelete && (
        <Button size="sm" variant="danger" confirm="Confirm?" onClick={() => onDelete(f.id)} title="Remove this flight from the logbook">
          Delete
        </Button>
      )}
    </span>
  )
}

// Colonnes communes des tables de vols.
const COL_DATE     = { key: 'date', label: 'DATE', mono: true, render: f => <span style={{ color: T.graphite, whiteSpace: 'nowrap' }}>{formatDateTime(f.startTs)}</span> }
const COL_DURATION = { key: 'duration', label: 'DURATION', mono: true, align: 'right', render: f => formatDuration(f.duration) }
const COL_TYPE     = { key: 'type', label: 'TYPE', render: f => <TypeBadge type={f.flightType} /> }
const COL_ALT      = { key: 'alt', label: 'ALT MAX', mono: true, align: 'right', render: f => (f.maxAlt ? <span style={{ color: T.graphite, whiteSpace: 'nowrap' }}>{`${Math.round(f.maxAlt)} ft`}</span> : DASH) }
const COL_G        = { key: 'g', label: 'G MAX', mono: true, align: 'right', render: f => <GMax g={f.maxG} /> }
const colAircraft  = acLabel => ({
  key: 'aircraft', label: 'AIRCRAFT', mono: true,
  render: f => <span title={f.aircraftIdent || ''}>{acLabel ? acLabel(f.aircraftIdent) : (f.aircraftIdent || '—')}</span>,
})

// Table dépliée dans une carte : sans cadre propre, séparée par un filet.
const NESTED_TABLE = { border: 'none', borderTop: T.border, borderRadius: 0 }

// Bloc chiffré aligné à droite dans l'en-tête des cartes.
function CardStat({ label, value, sub, minWidth }) {
  return (
    <div style={{ textAlign: 'right', minWidth }}>
      <div style={labelStyle(T.etch)}>{label}</div>
      <div style={{ ...valueStyle(18), marginTop: 6 }}>{value}</div>
      {sub}
    </div>
  )
}

// En-tête de carte dépliable (clic + Entrée/Espace).
function CardHeader({ open, onToggle, columns, children }) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      className="ak-focus"
      onClick={onToggle}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
      style={{ display: 'grid', gridTemplateColumns: columns, gap: 20, padding: '14px 16px', cursor: 'pointer', alignItems: 'center' }}
    >
      {children}
      <Icon name="chevron-right" size={16} color={T.graphite} style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
    </div>
  )
}

const cardStyle = open => ({
  background: T.card, border: `1px solid ${open ? T.graphite : T.rule}`, borderRadius: T.radius.md, overflow: 'hidden',
})

// ─── PilotCard ────────────────────────────────────────────────────────────────

// Puce propriété avion — CLUB / OWNER (texte graphite bordé, plus de rouge/bleu).
function OwnershipBadge({ ac }) {
  return <Chip>{ac?.ownership === 'owner' ? 'OWNER' : 'CLUB'}</Chip>
}

function PilotCard({ pilot, flights, pilots, mode, acLabel, onReplay, onAssign }) {
  const [open, setOpen] = useState(false)

  const myFlights = useMemo(() => {
    const raw = mode === 'pilot'
      ? flights.filter(f => f.pilotId === pilot.id)
      : flights.filter(f => f.instructorId === pilot.id)
    return sortByDateDesc(raw)
  }, [flights, pilot.id, mode])

  const total = sumDuration(myFlights)
  const last  = myFlights[0]

  const onboard    = mode === 'instructor' ? myFlights.filter(f =>  f.instructorOnboard) : []
  const fromGround = mode === 'instructor' ? myFlights.filter(f => !f.instructorOnboard) : []

  const byType = useMemo(() => {
    if (mode !== 'pilot') return {}
    return myFlights.reduce((acc, f) => {
      const t = f.flightType || 'solo'
      acc[t] = (acc[t] || 0) + (f.duration || 0)
      return acc
    }, {})
  }, [myFlights, mode])

  const counterparts = useMemo(() => {
    if (mode === 'pilot') {
      const ids = [...new Set(myFlights.filter(f => f.instructorId).map(f => f.instructorId))]
      return ids.map(id => getPilotName(pilots, id))
    } else {
      const ids = [...new Set(myFlights.map(f => f.pilotId).filter(Boolean))]
      return ids.map(id => getPilotName(pilots, id))
    }
  }, [myFlights, pilots, mode])

  const unvalidated = myFlights.filter(f => f._pending).length

  const columns = [
    COL_DATE,
    colAircraft(acLabel),
    ...(mode === 'instructor' ? [{ key: 'student', label: 'STUDENT', render: f => getPilotName(pilots, f.pilotId) }] : []),
    ...(mode === 'pilot' ? [{ key: 'instr', label: 'INSTRUCTOR', render: f => (f.instructorId ? <span style={{ color: T.graphite }}>{getPilotName(pilots, f.instructorId)}</span> : DASH) }] : []),
    COL_DURATION,
    COL_TYPE,
    ...(mode === 'instructor' ? [{ key: 'presence', label: 'PRESENCE', render: f => <span style={{ color: T.graphite }}>{presenceText(f)}</span> }] : []),
    COL_ALT,
    COL_G,
    { key: 'actions', label: '', align: 'right', render: f => <RowActions f={f} onReplay={onReplay} onAssign={onAssign} /> },
  ]

  return (
    <div style={cardStyle(open)}>
      <CardHeader open={open} onToggle={() => setOpen(v => !v)} columns="1fr repeat(3, auto) 16px">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={headingStyle(15)}>{pilot.firstName} {pilot.lastName}</span>
            {unvalidated > 0 && <StatusDot tone="caution" text={`${unvalidated} TO ASSIGN`} />}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {(pilot.licences || []).map(lic => <Chip key={lic}>{lic}</Chip>)}
            {counterparts.length > 0 && (
              <span style={{ color: T.graphite, fontSize: 12 }}>
                {mode === 'pilot' ? 'With' : 'Students'}: {counterparts.slice(0, 2).join(', ')}
                {counterparts.length > 2 && <span style={monoStyle(12, T.graphite)}>{` +${counterparts.length - 2}`}</span>}
              </span>
            )}
          </div>
        </div>
        <CardStat label="TOTAL" value={formatDuration(total)} />
        <CardStat
          label="FLIGHTS"
          value={myFlights.length}
          sub={mode === 'instructor' && myFlights.length > 0 && (
            <div style={{ ...monoStyle(11, T.graphite), marginTop: 4, whiteSpace: 'nowrap' }}>
              {onboard.length} on board · {fromGround.length} ground
            </div>
          )}
        />
        <div style={{ textAlign: 'right', minWidth: 118 }}>
          <div style={labelStyle(T.etch)}>LAST FLIGHT</div>
          <div style={{ ...monoStyle(12, T.ink), marginTop: 6 }}>{last ? formatDate(last.startTs) : '—'}</div>
          {last && <div style={{ marginTop: 4 }}><TypeBadge type={last.flightType} /></div>}
        </div>
      </CardHeader>

      {open && mode === 'pilot' && Object.keys(byType).length > 0 && (
        <div style={{ borderTop: T.border, padding: '10px 16px', display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          {Object.entries(byType).map(([type, secs]) => {
            const ft = FLIGHT_TYPES[type]
            if (!ft) return null
            return (
              <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Dot color={ft.color} />
                <span style={{ color: T.graphite, fontSize: 12 }}>{ft.label}</span>
                <span style={monoStyle(12, T.ink)}>{formatDuration(secs)}</span>
              </div>
            )
          })}
        </div>
      )}

      {open && myFlights.length > 0 && <DataTable columns={columns} rows={myFlights} style={NESTED_TABLE} />}

      {open && myFlights.length === 0 && (
        <div style={{ borderTop: T.border }}><EmptyState text="No flights recorded." /></div>
      )}
    </div>
  )
}

// ─── AircraftCard ─────────────────────────────────────────────────────────────

function AircraftCard({ ac, flights, pilots, onReplay, onAssign }) {
  const [open, setOpen] = useState(false)

  const acFlights = useMemo(() => {
    const ids = [ac.callSign, ac.registration].filter(Boolean)   // callSign canonique + registration legacy
    return sortByDateDesc(flights.filter(f => ids.includes(f.aircraftIdent)))
  }, [flights, ac.callSign, ac.registration])
  const total = sumDuration(acFlights)
  const last  = acFlights[0]
  const lastPilot = last?.pilotId ? getPilotName(pilots, last.pilotId) : null
  const uniquePilots = useMemo(() => new Set(acFlights.map(f => f.pilotId).filter(Boolean)).size, [acFlights])
  const byType = useMemo(() => acFlights.reduce((acc, f) => { const t = f.flightType || 'solo'; acc[t] = (acc[t] || 0) + 1; return acc }, {}), [acFlights])

  const columns = [
    COL_DATE,
    { key: 'pilot', label: 'PILOT', render: f => getPilotName(pilots, f.pilotId) },
    { key: 'instr', label: 'INSTRUCTOR', render: f => (f.instructorId
      ? <span style={{ color: T.graphite }}>{getPilotName(pilots, f.instructorId)} · {presenceText(f).toLowerCase()}</span>
      : DASH) },
    COL_DURATION,
    COL_TYPE,
    COL_ALT,
    COL_G,
    { key: 'actions', label: '', align: 'right', render: f => <RowActions f={f} onReplay={onReplay} onAssign={onAssign} /> },
  ]

  return (
    <div style={cardStyle(open)}>
      <CardHeader open={open} onToggle={() => setOpen(v => !v)} columns="auto 1fr repeat(4, auto) 16px">
        <div style={{
          width: 40, height: 40, background: T.paper, border: T.border, borderRadius: T.radius.sm,
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.ink, flexShrink: 0,
        }}>
          <Icon name="plane" size={20} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...monoStyle(16, T.ink), fontWeight: 600 }}>{ac.callSign || ac.registration}</span>
            <OwnershipBadge ac={ac} />
          </div>
          <div style={{ color: T.graphite, fontSize: 12, marginTop: 4 }}>
            {[ac.ownership === 'owner' ? `Owner: ${getPilotName(pilots, ac.ownerPilotId)}` : null, ac.typeDesig || ac.type].filter(Boolean).join(' · ')}
            {ac.icao24 && <span style={monoStyle(12, T.graphite)}>{`${ac.ownership === 'owner' || ac.typeDesig || ac.type ? ' · ' : ''}${ac.icao24.toUpperCase()}`}</span>}
          </div>
          <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
            {Object.entries(byType).map(([type, cnt]) => {
              const ft = FLIGHT_TYPES[type]
              return ft ? (
                <span key={type} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <Dot color={ft.color} size={6} />
                  <span style={{ ...monoStyle(11, T.graphite) }}>{cnt}×</span>
                  <span style={{ color: T.graphite, fontSize: 11 }}>{ft.label}</span>
                </span>
              ) : null
            })}
          </div>
        </div>
        <CardStat label="TOTAL" value={formatDuration(total)} />
        <CardStat label="FLIGHTS" value={acFlights.length} />
        <CardStat label="PILOTS" value={uniquePilots} />
        <div style={{ textAlign: 'right', minWidth: 110 }}>
          <div style={labelStyle(T.etch)}>LAST FLIGHT</div>
          <div style={{ ...monoStyle(12, T.ink), marginTop: 6 }}>{last ? formatDate(last.startTs) : '—'}</div>
          {lastPilot && <div style={{ color: T.graphite, fontSize: 12, marginTop: 2 }}>{lastPilot}</div>}
        </div>
      </CardHeader>

      {open && acFlights.length > 0 && <DataTable columns={columns} rows={acFlights} style={NESTED_TABLE} />}
      {open && acFlights.length === 0 && (
        <div style={{ borderTop: T.border }}><EmptyState text="No flights for this aircraft." /></div>
      )}
    </div>
  )
}

// ─── FlightMatrix ─────────────────────────────────────────────────────────────

const SELECT_STYLE = {
  background: T.card, border: T.border, color: T.ink, fontFamily: T.sans, fontSize: 13,
  height: 34, padding: '0 10px', borderRadius: T.radius.sm, cursor: 'pointer',
}

function FlightMatrix({ flights, pilots, aircraft, acLabel, onReplay, onAssign, canDelete, onDelete }) {
  // Suppression en 2 temps (1er clic arme, 2e archive, désarmement 5 s) : portée par
  // <Button variant="danger" confirm="Confirm?">.
  const [filterPilot,    setFilterPilot]    = useState('')
  const [filterInstr,    setFilterInstr]    = useState('')
  const [filterAircraft, setFilterAircraft] = useState('')
  const [filterType,     setFilterType]     = useState('')
  const [filterStatus,   setFilterStatus]   = useState('')
  const [sortKey,        setSortKey]        = useState('date')
  const [sortDir,        setSortDir]        = useState('desc')

  const instructors = useMemo(() => pilots.filter(p => p.isInstructor === true), [pilots])

  const filtered = useMemo(() => {
    let list = [...flights]
    if (filterPilot)    list = list.filter(f => f.pilotId === filterPilot)
    if (filterInstr)    list = list.filter(f => f.instructorId === filterInstr)
    if (filterAircraft) list = list.filter(f => acLabel(f.aircraftIdent) === filterAircraft)   // résout legacy 59DWG -> callSign
    if (filterType)     list = list.filter(f => f.flightType === filterType)
    if (filterStatus === 'validated') list = list.filter(f => !f._pending)
    if (filterStatus === 'pending')   list = list.filter(f =>  f._pending)
    list.sort((a, b) => {
      let va, vb
      if (sortKey === 'date')     { va = tsMillis(a.startTs); vb = tsMillis(b.startTs) }
      if (sortKey === 'duration') { va = a.duration || 0; vb = b.duration || 0 }
      if (sortKey === 'aircraft') { va = a.aircraftIdent || ''; vb = b.aircraftIdent || '' }
      if (va < vb) return sortDir === 'asc' ? -1 : 1
      if (va > vb) return sortDir === 'asc' ?  1 : -1
      return 0
    })
    return list
  }, [flights, filterPilot, filterInstr, filterAircraft, filterType, filterStatus, sortKey, sortDir, acLabel])

  const toggleSort = key => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('desc') }
  }

  // En-tête triable : bouton dans le <th> de DataTable.
  const sortLabel = (text, skey) => (
    <button
      type="button"
      className="ak-focus"
      onClick={() => toggleSort(skey)}
      aria-label={`Sort by ${text.toLowerCase()}`}
      style={{
        ...labelStyle(sortKey === skey ? T.ink : T.etch),
        background: 'none', border: 'none', padding: 0, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
      }}
    >
      {text}{sortKey === skey ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
    </button>
  )

  const pendingCount = flights.filter(f => f._pending).length

  const columns = [
    { ...COL_DATE, label: sortLabel('DATE', 'date') },
    { ...colAircraft(acLabel), label: sortLabel('AIRCRAFT', 'aircraft') },
    // Terrains déduits du GPS (normalizeFlight). '—' = aucun terrain connu à
    // moins de 5 km : soit hors base AIP, soit le log ne démarre pas au sol.
    { key: 'route', label: 'ROUTE', mono: true, render: f => <Route f={f} /> },
    // (22/09) ROLE fusionné dans PILOT, PRESENCE sous INSTRUCTOR : 13 → 11 colonnes, plus de défilement horizontal.
    { key: 'pilot', label: 'PILOT', render: f => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
        {getPilotName(pilots, f.pilotId)}
        {f.pilotRole === 'student' ? <Chip>STUDENT</Chip> : f.pilotRole === 'pilot' ? <Chip>PILOT</Chip> : null}
      </span>
    ) },
    { key: 'instr', label: 'INSTRUCTOR', render: f => (f.instructorId ? (
      <span style={{ display: 'flex', flexDirection: 'column', whiteSpace: 'nowrap' }}>
        <span style={{ color: T.graphite }}>{getPilotName(pilots, f.instructorId)}</span>
        <span style={{ ...monoStyle(10, T.etch), letterSpacing: '0.08em' }}>{presenceText(f).toUpperCase()}</span>
      </span>
    ) : DASH) },
    { ...COL_DURATION, label: sortLabel('DURATION', 'duration') },
    COL_TYPE,
    COL_ALT,
    { key: 'status', label: 'STATUS', render: f => <ValidBadge validated={!f._pending} /> },
    { key: 'actions', label: '', align: 'right', render: f => (
      <RowActions f={f} onReplay={onReplay} onAssign={onAssign} canDelete={canDelete} onDelete={onDelete} />
    ) },
  ]

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
        <Icon name="filter" size={16} color={T.graphite} />
        <select aria-label="Filter by pilot" className="ak-focus" value={filterPilot} onChange={e => setFilterPilot(e.target.value)} style={SELECT_STYLE}>
          <option value="">All pilots</option>
          {pilots.map(p => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
        </select>
        <select aria-label="Filter by instructor" className="ak-focus" value={filterInstr} onChange={e => setFilterInstr(e.target.value)} style={SELECT_STYLE}>
          <option value="">All instructors</option>
          {instructors.map(p => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
        </select>
        <select aria-label="Filter by aircraft" className="ak-focus" value={filterAircraft} onChange={e => setFilterAircraft(e.target.value)} style={SELECT_STYLE}>
          <option value="">All aircraft</option>
          {aircraft.map(a => { const cs = a.callSign || a.registration; return <option key={a.id} value={cs}>{cs} — {a.typeDesig || a.type}</option> })}
        </select>
        <select aria-label="Filter by flight type" className="ak-focus" value={filterType} onChange={e => setFilterType(e.target.value)} style={SELECT_STYLE}>
          <option value="">All types</option>
          {Object.entries(FLIGHT_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select aria-label="Filter by status" className="ak-focus" value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={SELECT_STYLE}>
          <option value="">All statuses</option>
          <option value="validated">Validated</option>
          <option value="pending">To assign ({pendingCount})</option>
        </select>
        <span style={{ ...monoStyle(12, T.graphite), marginLeft: 'auto' }}>
          {filtered.length} flight{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      <DataTable columns={columns} rows={filtered} empty={<EmptyState text="No matching flights." />} />
    </div>
  )
}

// ─── MyFlights ────────────────────────────────────────────────────────────────
// Vols du compte connecté (fiche /pilots reliée par e-mail) : comme pilote (pilotId), et
// comme instructeur (instructorId) si la fiche est instructeur. Lecture seule : aucune
// action d'attribution/suppression ici, seulement « Open Loop ».
function MyFlights({ me, flights, pilots, acLabel, onReplay }) {
  const total = sumDuration(flights)
  const last  = flights[0]
  const columns = [
    COL_DATE,
    colAircraft(acLabel),
    { key: 'route', label: 'ROUTE', mono: true, render: f => <Route f={f} /> },
    { key: 'pilot', label: 'PILOT', render: f => <span style={{ fontWeight: f.pilotId === me.id ? 600 : 400 }}>{getPilotName(pilots, f.pilotId)}</span> },
    { key: 'instr', label: 'INSTRUCTOR', render: f => (f.instructorId
      ? <span style={{ color: f.instructorId === me.id ? T.ink : T.graphite, fontWeight: f.instructorId === me.id ? 600 : 400 }}>
          {getPilotName(pilots, f.instructorId)} · {presenceText(f).toLowerCase()}
        </span>
      : DASH) },
    COL_DURATION,
    COL_TYPE,
    COL_ALT,
    COL_G,
    { key: 'actions', label: '', align: 'right', render: f => <RowActions f={f} onReplay={onReplay} /> },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 16 }}>
        <MetricCard label="FLIGHTS"     value={flights.length} />
        <MetricCard label="HOURS"       value={formatDuration(total)} />
        <MetricCard label="LAST FLIGHT" value={last ? formatDate(last.startTs) : null} />
      </div>

      <DataTable columns={columns} rows={flights} empty={<EmptyState text="No flights recorded yet." />} />
    </div>
  )
}

// ─── CsvImportCard ────────────────────────────────────────────────────────────
// Import d'un CSV G3X depuis le Logbook (instructor/admin/super_admin).
// Upload Storage flights/{uid}/{timestamp}_{nom}.csv puis doc /flights non validé :
// le vol arrive par onSnapshot dans la file « To assign » et s'attribue avec la
// modale existante. Inspiré de UploadZone (ReplayPage), mais sans assignation inline.
// Composant top-level : jamais déclaré dans LogbookPage (sinon remount à chaque rendu).
function CsvImportCard({ clubId }) {
  const [dragging,  setDragging]  = useState(false)
  const [uploading, setUploading] = useState(false)
  const [progress,  setProgress]  = useState(0)
  const [error,     setError]     = useState('')
  const [info,      setInfo]      = useState('')
  const inputRef = useRef(null)

  const processFile = async (file) => {
    if (uploading) return
    setError(''); setInfo('')
    if (!file || !file.name.toLowerCase().endsWith('.csv')) { setError('Please select a G3X CSV file'); return }
    const user = auth.currentUser
    if (!user)   { setError('You must be signed in to import a flight'); return }
    if (!clubId) { setError('No club selected'); return }
    setUploading(true); setProgress(0)
    try {
      // Stats extraites si le CSV est lisible ; un échec de parsing n'empêche pas l'import
      // (le fichier brut reste exploitable), mais on le signale.
      let stats = null
      try { stats = parseG3XCSV(await file.text()).stats }
      catch (e) { console.warn('[Logbook import] CSV parse:', e) }

      const path = `flights/${user.uid}/${Date.now()}_${file.name}`
      const task = uploadBytesResumable(ref(storage, path), file)
      await new Promise((resolve, reject) => {
        task.on('state_changed',
          snap => setProgress(Math.round(snap.bytesTransferred / snap.totalBytes * 100)),
          reject,
          resolve,
        )
      })

      await addDoc(collection(db, 'flights'), {
        clubId,
        csvStoragePath: path,
        fileName:       file.name,
        source:         'dashboard-import',
        validated:      false,
        uploadedBy:     user.email || null,
        createdAt:      serverTimestamp(),
        uploadedAt:     serverTimestamp(),   // (21/09) champ historique lu par le reste de l'app
        aircraftIdent:  '',
        ...(stats ? {
          startTs:     stats.startTs,
          endTs:       stats.endTs,
          duration:    stats.duration,     // champ lu par tout le Logbook (secondes)
          durationSec: stats.duration,
          maxAlt:      stats.maxAlt,
          maxSpd:      stats.maxSpd,
          maxG:        stats.maxG,
          maxRpm:      stats.maxRpm,
          bounds:      stats.bounds,
        } : {}),
      })
      setInfo(stats
        ? `${file.name} imported — now in the To assign queue`
        : `${file.name} imported without flight data (CSV not recognised) — now in the To assign queue`)
    } catch (e) {
      console.error('[Logbook import]', e)
      setError('Import failed: ' + e.message)
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <div style={{ background: T.card, border: T.border, borderRadius: T.radius.md, padding: '14px 16px', marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={labelStyle(T.etch)}>IMPORT CSV</div>
        <div
          onClick={() => !uploading && inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); processFile(e.dataTransfer.files[0]) }}
          style={{
            flex: 1, minWidth: 220,
            border: `1px dashed ${dragging ? T.ink : T.rule}`,
            background: dragging ? T.paper : 'transparent',
            borderRadius: T.radius.sm, padding: '10px 14px', textAlign: 'center',
            color: T.graphite, fontFamily: T.sans, fontSize: 13,
            cursor: uploading ? 'wait' : 'pointer',
          }}
        >
          {uploading
            ? <>Uploading… <span style={monoStyle(13, T.ink)}>{progress}%</span></>
            : 'Drop a Garmin G3X CSV here'}
        </div>
        <input ref={inputRef} type="file" accept=".csv" style={{ display: 'none' }}
          onChange={e => processFile(e.target.files[0])} />
        <Button icon="upload" disabled={uploading} onClick={() => inputRef.current?.click()}>
          Choose file
        </Button>
      </div>
      {error && <Banner tone="caution" style={{ marginTop: 12 }}>{error}</Banner>}
      {info  && <Banner tone="ok" style={{ marginTop: 12 }}>{info}</Banner>}
    </div>
  )
}

// ─── SortBar ──────────────────────────────────────────────────────────────────
// Top-level (déclaré hors de LogbookPage pour ne pas remonter à chaque rendu).
function SortBar({ value, onChange, options }) {
  return (
    <div role="group" aria-label="Sort by" style={{ display: 'flex', gap: 6, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ ...labelStyle(T.etch), marginRight: 4 }}>SORT BY</span>
      {options.map(opt => (
        <Button
          key={opt.key}
          size="sm"
          variant={value === opt.key ? 'primary' : 'secondary'}
          aria-pressed={value === opt.key}
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
        </Button>
      ))}
    </div>
  )
}

const PILOT_SORTS    = [{ key: 'alpha', label: 'A→Z' }, { key: 'lastFlight', label: 'Last flight' }, { key: 'hours', label: 'Hours ↓' }]
const AIRCRAFT_SORTS = [{ key: 'alpha', label: 'A→Z' }, { key: 'lastFlight', label: 'Last flight' }, { key: 'hours', label: 'Hours ↓' }]

// Colonnes fantômes affichées pendant le chargement (DataTable loading).
const LOADING_COLUMNS = [
  { key: 'date', label: 'DATE' }, { key: 'aircraft', label: 'AIRCRAFT' }, { key: 'pilot', label: 'PILOT' },
  { key: 'duration', label: 'DURATION', align: 'right' }, { key: 'type', label: 'TYPE' },
]

const EMPTY_LIST = { background: T.card, border: T.border, borderRadius: T.radius.md }

// ─── LogbookPage ──────────────────────────────────────────────────────────────

export default function LogbookPage({ role }) {
  const { clubId, club } = useClub()
  const canDelete = role === 'admin' || role === 'super_admin'
  const canImport = IMPORT_ROLES.includes(role)
  const isPilot   = role === 'user'   // libellé « Pilot » : ne voit que « My flights »
  const location  = useLocation()
  // Onglet par défaut : pilote → My flights ; instructeur/admin → All flights.
  // Retour de Loop : location.state.tab rouvre l'onglet d'où le vol a été ouvert.
  const [tab,          setTab]          = useState(() => location.state?.tab || (isPilot ? 'mine' : 'matrix'))
  const [pilots,       setPilots]       = useState([])
  const [aircraft,     setAircraft]     = useState([])
  const [rawFlights,   setRawFlights]   = useState([])
  const [archivedFlights, setArchivedFlights] = useState([])   // (21/09) vols archivés (onglet Archived, admin)
  const [refsLoading,    setRefsLoading]    = useState(true)
  const [flightsLoading, setFlightsLoading] = useState(true)
  const [assignFlight, setAssignFlight] = useState(null)
  const navigate = useNavigate()
  const loading = refsLoading || flightsLoading

  const [loadError, setLoadError] = useState(null)

  // Affichage avion = indicatif (callSign) si déclaré, sinon immat. f.aircraftIdent
  // reste la clé (filtre/tri) ; partagé avec FlightMatrix et les cartes.
  // callSign = identifiant canonique. Résout un aircraftIdent (callSign OU ancienne
  // registration legacy type "59DWG") vers le callSign affiché (ex "FJFVB").
  const acLabel = useMemo(() => {
    const byIdent = new Map()
    aircraft.forEach(a => {
      const cs = a.callSign || a.registration
      if (a.registration) byIdent.set(a.registration, cs)
      if (a.callSign)     byIdent.set(a.callSign, cs)
    })
    return ident => (ident ? (byIdent.get(ident) || ident) : '—')
  }, [aircraft])

  // Pilots/aircraft : lecture one-shot scopée club, archivés exclus.
  // Vols legacy ESP32 (champ club_id snake_case) ne s'affichent pas — backfill
  // requis pour les voir dans le carnet.
  useEffect(() => {
    if (!clubId) { setPilots([]); setAircraft([]); setRefsLoading(false); return }
    let cancelled = false
    async function load() {
      setRefsLoading(true)
      setLoadError(null)
      try {
        const [pilotsSnap, aircraftSnap] = await Promise.all([
          getDocs(query(collection(db, 'pilots'),   where('clubId', '==', clubId))),
          getDocs(query(collection(db, 'aircraft'), where('clubId', '==', clubId))),
        ])
        if (cancelled) return
        setPilots(pilotsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.archived !== true))
        setAircraft(aircraftSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => a.archived !== true))
      } catch (e) {
        console.error('Logbook load error:', e)
        if (!cancelled) setLoadError(e.message)
      } finally {
        if (!cancelled) setRefsLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [clubId])

  // Flights : temps réel (import, attribution, archivage apparaissent sans recharger).
  // Les vols archivés (soft delete) sont exclus ICI, donc de toutes les listes/stats.
  useEffect(() => {
    if (!clubId) { setRawFlights([]); setFlightsLoading(false); return }
    setFlightsLoading(true)
    const unsub = onSnapshot(
      query(collection(db, 'flights'), where('clubId', '==', clubId)),
      snap => {
        const all = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        setRawFlights(all.filter(f => f.archived !== true))
        setArchivedFlights(sortByDateDesc(all.filter(f => f.archived === true)))   // (21/09) onglet Archived (admin)
        setFlightsLoading(false)
      },
      err => {
        console.error('Logbook flights listener:', err)
        setLoadError(err.message)
        setFlightsLoading(false)
      },
    )
    return unsub
  }, [clubId])

  // _pending = vol dans la file « To assign » (règle needsAssignment : vols
  // propriétaire déjà attribués exclus). Calculé une fois, lu par tous les rendus.
  const flights = useMemo(
    () => rawFlights.map(f => ({ ...f, _pending: needsAssignment(f, aircraft) })),
    [rawFlights, aircraft],
  )

  // Fiche /pilots du compte connecté (uid via code d'invitation, sinon e-mail) → « My flights ».
  const myUid   = auth.currentUser?.uid || ''
  const myEmail = auth.currentUser?.email || ''
  const me = useMemo(() => findMyPilot(pilots, { uid: myUid, email: myEmail }), [pilots, myUid, myEmail])
  const myFlights = useMemo(() => {
    if (!me) return []
    return sortByDateDesc(flights.filter(f =>
      f.pilotId === me.id || (me.isInstructor === true && f.instructorId === me.id)))
  }, [flights, me])

  // Onglet effectivement affiché : le pilote est cantonné à « My flights » ; un onglet
  // « My flights » sans fiche reliée (ou une clé inconnue venue de l'historique) retombe
  // sur All flights une fois les données chargées.
  const TAB_KEYS = ['mine', 'pilots', 'instructors', 'aircraft', 'matrix']
  const activeTab = isPilot ? 'mine'
    : !TAB_KEYS.includes(tab) ? 'matrix'
    : (tab === 'mine' && !me && !refsLoading) ? 'matrix'
    : tab

  // ── Sort state ─ un état par onglet (Instructors indépendant de Pilots) ──────
  const [sortPilots,      setSortPilots]      = useState('alpha')   // 'alpha' | 'lastFlight' | 'hours'
  const [sortInstructors, setSortInstructors] = useState('alpha')   // 'alpha' | 'lastFlight' | 'hours'
  const [sortAircraft,    setSortAircraft]    = useState('alpha')   // 'alpha' | 'lastFlight' | 'hours'

  // La modale a déjà écrit en base ; onSnapshot rafraîchit la liste. Rien à faire ici.
  const handleAssigned = useCallback(() => {}, [])

  // Loop = lecteur d'un vol. On mémorise l'onglet pour que « Back to logbook » le rouvre.
  const handleReplay = useCallback(
    id => navigate(`/replay/${id}`, { state: { from: '/logbook', tab: activeTab } }),
    [navigate, activeTab],
  )
  const handleAssign = useCallback(f => setAssignFlight(f), [])

  // ── (21/09) VOLS ARCHIVÉS : lisibles dans Loop ; Restore les remet dans le carnet ; PURGE = suppression
  // définitive du vol ET de ses traces (CSV du vol + journal LTE, effacés par la fonction cloud onFlightDeleted,
  // qui garde un fichier encore utilisé par un autre vol). Confirmation explicite par bannière avant toute purge.
  const [purgeAsk, setPurgeAsk]     = useState(null)   // { ids:[], label } — confirmation en attente
  const [purgeState, setPurgeState] = useState(null)   // { tone, text } — résultat
  const [purging, setPurging]       = useState(false)
  const restoreFlight = useCallback(async (id) => {
    try { await updateDoc(doc(db, 'flights', id), { archived: false, restoredAt: serverTimestamp(), restoredBy: auth.currentUser?.email || null }) }
    catch (e) { setPurgeState({ tone: 'caution', text: 'Restore refused: ' + e.message }) }
  }, [])
  const doPurge = async () => {
    if (!purgeAsk) return
    setPurging(true); let done = 0; const failed = []
    for (const id of purgeAsk.ids) {
      try { await deleteDoc(doc(db, 'flights', id)); done++ } catch (e) { failed.push(e.message) }
    }
    setPurging(false); setPurgeAsk(null)
    setPurgeState(failed.length
      ? { tone: 'caution', text: `${done} flight${done === 1 ? '' : 's'} purged, ${failed.length} refused: ${failed[0]}` }
      : { tone: 'ok', text: `${done} flight${done === 1 ? '' : 's'} purged with ${done === 1 ? 'its' : 'their'} recordings.` })
  }

  // Suppression DOUCE (admin) — jamais de deleteDoc : archived=true + traçabilité.
  // Le CSV Storage est conservé ; onSnapshot retire la ligne des listes.
  const handleDelete = useCallback(async (id) => {
    try {
      await updateDoc(doc(db, 'flights', id), {
        archived:   true,
        archivedAt: serverTimestamp(),
        archivedBy: auth.currentUser?.email || null,
      })
    } catch (e) {
      console.error('Archive flight:', e)
      alert('Delete refused: ' + e.message)
    }
  }, [])

  const totalSeconds  = useMemo(() => flights.reduce((s, f) => s + (f.duration || 0), 0), [flights])
  const pendingCount  = useMemo(() => flights.filter(f => f._pending).length, [flights])
  const instructors   = useMemo(() => pilots.filter(p => p.isInstructor === true), [pilots])
  const regularPilots = useMemo(() => pilots, [pilots])

  // ── Sorted lists ─────────────────────────────────────────────────────────────
  const sortedPilots = useMemo(() => {
    const withStats = regularPilots.map(p => {
      const pFlights = flights.filter(f => f.pilotId === p.id)
      const last = pFlights.sort((a, b) => tsMillis(b.startTs) - tsMillis(a.startTs))[0]
      return { ...p, _totalSecs: pFlights.reduce((s, f) => s + (f.duration || 0), 0), _lastTs: last ? tsMillis(last.startTs) : null }
    })
    if (sortPilots === 'alpha')      return [...withStats].sort((a, b) => (a.lastName || '').localeCompare(b.lastName || ''))
    if (sortPilots === 'lastFlight') return [...withStats].sort((a, b) => (b._lastTs || 0) - (a._lastTs || 0))
    if (sortPilots === 'hours')      return [...withStats].sort((a, b) => b._totalSecs - a._totalSecs)
    return withStats
  }, [regularPilots, flights, sortPilots])

  const sortedInstructors = useMemo(() => {
    const withStats = instructors.map(p => {
      const pFlights = flights.filter(f => f.instructorId === p.id)
      const last = pFlights.sort((a, b) => tsMillis(b.startTs) - tsMillis(a.startTs))[0]
      return { ...p, _totalSecs: pFlights.reduce((s, f) => s + (f.duration || 0), 0), _lastTs: last ? tsMillis(last.startTs) : null }
    })
    if (sortInstructors === 'alpha')      return [...withStats].sort((a, b) => (a.lastName || '').localeCompare(b.lastName || ''))
    if (sortInstructors === 'lastFlight') return [...withStats].sort((a, b) => (b._lastTs || 0) - (a._lastTs || 0))
    if (sortInstructors === 'hours')      return [...withStats].sort((a, b) => b._totalSecs - a._totalSecs)
    return withStats
  }, [instructors, flights, sortInstructors])

  const sortedAircraft = useMemo(() => {
    const withStats = aircraft.map(ac => {
      const ids = [ac.callSign, ac.registration].filter(Boolean)   // callSign canonique + registration legacy
      const acFlights = flights.filter(f => ids.includes(f.aircraftIdent))
      const last = acFlights.sort((a, b) => tsMillis(b.startTs) - tsMillis(a.startTs))[0]
      return { ...ac, _totalSecs: acFlights.reduce((s, f) => s + (f.duration || 0), 0), _lastTs: last ? tsMillis(last.startTs) : null }
    })
    if (sortAircraft === 'alpha')      return [...withStats].sort((a, b) => (a.callSign || a.registration || '').localeCompare(b.callSign || b.registration || ''))
    if (sortAircraft === 'lastFlight') return [...withStats].sort((a, b) => (b._lastTs || 0) - (a._lastTs || 0))
    if (sortAircraft === 'hours')      return [...withStats].sort((a, b) => b._totalSecs - a._totalSecs)
    return withStats
  }, [aircraft, flights, sortAircraft])

  const TABS = isPilot ? [
    { key: 'mine',        label: 'My flights', count: myFlights.length },
  ] : [
    ...(me ? [{ key: 'mine', label: 'My flights', count: myFlights.length }] : []),
    { key: 'pilots',      label: 'Pilots',      count: regularPilots.length },
    { key: 'instructors', label: 'Instructors', count: instructors.length },
    { key: 'aircraft',    label: 'Aircraft',    count: aircraft.length },
    { key: 'matrix',      label: 'All flights', count: pendingCount > 0 ? `${pendingCount} to assign` : undefined },
    ...(canDelete ? [{ key: 'archived', label: 'Archived', count: archivedFlights.length || undefined }] : []),
  ]

  const clubLine = [club?.name, club?.icao, new Date().getFullYear()].filter(Boolean).join(' · ')

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: T.paper, fontFamily: T.sans, color: T.ink }}>
      <div style={{ padding: '28px 32px 48px', maxWidth: 1280, margin: '0 auto' }}>

        <div style={{ marginBottom: 24 }}>
          {clubLine && <div style={{ ...labelStyle(T.etch), marginBottom: 8 }}>{clubLine}</div>}
          <h1 style={{ ...headingStyle(28), margin: 0 }}>Logbook</h1>
        </div>

        {loadError && (
          <Banner tone="caution" title="Could not load the logbook" style={{ marginBottom: 20 }}>
            {loadError}
          </Banner>
        )}

        {!isPilot && !loading && !loadError && pilots.length === 0 && flights.length === 0 && (
          <Banner tone="info" style={{ marginBottom: 20 }}>No data for this club yet.</Banner>
        )}

        {!isPilot && !loading && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 24 }}>
            <MetricCard label="PILOTS"        value={regularPilots.length} />
            <MetricCard label="INSTRUCTORS"   value={instructors.length} />
            <MetricCard label="AIRCRAFT"      value={aircraft.length} />
            <MetricCard label="TOTAL FLIGHTS" value={flights.length} />
            <MetricCard label="TOTAL HOURS"   value={formatDuration(totalSeconds)} />
          </div>
        )}

        {canImport && <CsvImportCard clubId={clubId} />}

        {isPilot && !loading && !loadError && !me && (
          <Banner
            tone="info"
            title="Your account is not linked to a pilot profile yet."
            style={{ marginBottom: 20 }}
          >
            <div style={{ marginBottom: 12 }}>Ask your club admin for an invitation code, then enter it here.</div>
            <RedeemInvite onDone={() => window.location.reload()} />
          </Banner>
        )}

        {!(isPilot && !loading && !me) && (
          <Tabs tabs={TABS} value={activeTab} onChange={setTab} ariaLabel="Logbook views" style={{ marginBottom: 20 }} />
        )}

        {loading ? (
          <DataTable loading columns={LOADING_COLUMNS} rows={[]} />
        ) : (
          <>
            {activeTab === 'mine' && me && (
              <MyFlights me={me} flights={myFlights} pilots={pilots} acLabel={acLabel} onReplay={handleReplay} />
            )}
            {!isPilot && activeTab === 'pilots' && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <SortBar value={sortPilots} onChange={setSortPilots} options={PILOT_SORTS} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {sortedPilots.length === 0 && <EmptyState text="No pilots in this club." style={EMPTY_LIST} />}
                  {sortedPilots.map(p => <PilotCard key={p.id} pilot={p} flights={flights} pilots={pilots} mode="pilot" acLabel={acLabel} onReplay={handleReplay} onAssign={handleAssign} />)}
                </div>
              </div>
            )}
            {!isPilot && activeTab === 'instructors' && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <SortBar value={sortInstructors} onChange={setSortInstructors} options={PILOT_SORTS} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {sortedInstructors.length === 0 && <EmptyState text="No instructors — check the instructor flag in Admin." style={EMPTY_LIST} />}
                  {sortedInstructors.map(p => <PilotCard key={p.id} pilot={p} flights={flights} pilots={pilots} mode="instructor" acLabel={acLabel} onReplay={handleReplay} onAssign={handleAssign} />)}
                </div>
              </div>
            )}
            {!isPilot && activeTab === 'aircraft' && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <SortBar value={sortAircraft} onChange={setSortAircraft} options={AIRCRAFT_SORTS} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {sortedAircraft.length === 0 && <EmptyState text="No aircraft in this club." style={EMPTY_LIST} />}
                  {sortedAircraft.map(ac => <AircraftCard key={ac.id} ac={ac} flights={flights} pilots={pilots} onReplay={handleReplay} onAssign={handleAssign} />)}
                </div>
              </div>
            )}
            {!isPilot && activeTab === 'matrix' && (
              <FlightMatrix flights={flights} pilots={pilots} aircraft={aircraft} acLabel={acLabel} onReplay={handleReplay} onAssign={handleAssign} canDelete={canDelete} onDelete={handleDelete} />
            )}
            {canDelete && activeTab === 'archived' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <Banner tone="info" title="Archived flights stay readable">
                  They are hidden from the lists and totals but their recordings are kept, so they can still be opened in Loop.
                  Restore puts a flight back in the logbook. Purge deletes the flight and its recordings for good.
                </Banner>
                {purgeState && (
                  <Banner tone={purgeState.tone} action={<Button size="sm" variant="ghost" onClick={() => setPurgeState(null)}>Dismiss</Button>}>{purgeState.text}</Banner>
                )}
                {purgeAsk && (
                  <Banner tone="caution" title={`Purge ${purgeAsk.label}?`}
                    action={<div style={{ display: 'flex', gap: 8 }}>
                      <Button size="sm" onClick={() => setPurgeAsk(null)} disabled={purging}>Cancel</Button>
                      <Button size="sm" variant="primary" onClick={doPurge} disabled={purging}>{purging ? 'Purging…' : 'Delete permanently'}</Button>
                    </div>}>
                    The flight record and its recordings (flight track CSV and LTE log) will be deleted permanently.
                    They cannot be replayed or recovered afterwards. To keep them readable, leave the flight archived.
                  </Banner>
                )}
                {archivedFlights.length > 0 && !purgeAsk && (
                  <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                    <Button variant="danger" onClick={() => { setPurgeState(null); setPurgeAsk({ ids: archivedFlights.map(f => f.id), label: `all ${archivedFlights.length} archived flight${archivedFlights.length === 1 ? '' : 's'}` }) }}>
                      Purge all archived ({archivedFlights.length})
                    </Button>
                  </div>
                )}
                <DataTable
                  rows={archivedFlights}
                  empty={<EmptyState text="No archived flights." />}
                  columns={[
                    COL_DATE,
                    colAircraft(acLabel),
                    { key: 'pilot', label: 'PILOT', render: f => getPilotName(pilots, f.pilotId) },
                    COL_DURATION,
                    { key: 'arch', label: 'ARCHIVED', mono: true, render: f => <span style={{ color: T.graphite, whiteSpace: 'nowrap' }}>{formatDate(f.archivedAt)}{f.archivedBy ? ` · ${f.archivedBy}` : ''}</span> },
                    { key: 'actions', label: '', align: 'right', render: f => (
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        <Button size="sm" icon="play" onClick={() => handleReplay(f.id)}>Open Loop</Button>
                        <Button size="sm" icon="refresh" onClick={() => restoreFlight(f.id)}>Restore</Button>
                        <Button size="sm" variant="danger" icon="close"
                          onClick={() => { setPurgeState(null); setPurgeAsk({ ids: [f.id], label: `${acLabel(f.aircraftIdent) || 'this flight'} · ${formatDate(f.startTs)}` }) }}>Purge</Button>
                      </div>
                    ) },
                  ]}
                />
              </div>
            )}
          </>
        )}
      </div>

      {assignFlight && (
        <FlightAssignModal
          flight={assignFlight}
          pilots={pilots}
          aircraft={aircraft}
          onSave={handleAssigned}
          onClose={() => setAssignFlight(null)}
        />
      )}
    </div>
  )
}
