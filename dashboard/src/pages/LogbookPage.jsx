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
import BulkAssignDrawer from '../components/logbook/BulkAssignDrawer'
import RedeemInvite from '../components/auth/RedeemInvite'
import {
  T, labelStyle, valueStyle, headingStyle, monoStyle,
  Button, MetricCard, StatusDot, DataTable, Tabs, Banner, EmptyState, Chip, Field, Select, Toggle, Icon,
} from '../components/ui'
import AircraftPhoto from '../components/aircraft/AircraftPhoto'
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
      {/* (22/09) Open Loop et Edit en boutons carrés à icône (nom en infobulle + aria-label) : la ligne tient à l'écran */}
      <Button size="sm" icon="play" onClick={() => onReplay(f.id)} title="Open Loop" aria-label="Open Loop" style={{ width: 32, padding: 0, justifyContent: 'center' }} />
      {onAssign && !f._pending && <Button size="sm" variant="ghost" icon="edit" onClick={() => onAssign(f)} title="Edit assignment" aria-label="Edit assignment" style={{ width: 32, padding: 0, justifyContent: 'center' }} />}
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


// ─── (22/09) All flights, d'après Claude Design Logbook (export AirKi Dashboard-3) ──────────────────────────
// 1. FILE « to assign » : bandeau encre (TO ASSIGN · OLDEST IN QUEUE · HOURS UNCREDITED · ASSIGNED AUTOMATICALLY) +
//    vols groupés par JOUR puis AVION, du plus ancien au plus récent, 20 à la fois. « Assign next flight » ouvre le
//    plus ancien ; le tiroir enchaîne (« Save & next flight »). ≤ 3 vols en attente → simple bandeau « queue clear ».
// 2. TABLEAU des vols (par défaut : validés), filtres en Field/Select, GROUP BY jour / avion / pilote / à plat,
//    SORT date / avion / pilote / durée. Colonnes empilées (date+heure, immat+type, pilote+rôle, type+instructeur)
//    pour tenir sans défilement horizontal.
// L'attribution GROUPÉE (« Assign these 5 ») et l'export CSV proposés par la maquette ne sont PAS construits (nouveaux,
// en attente d'accord de Christophe).
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const utcDay  = ts => { const t = tsMillis(ts); return t ? new Date(t).toISOString().slice(0, 10) : '' }
const dayCaps = ts => { const t = tsMillis(ts); if (!t) return '−−−'; const d = new Date(t); return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` }
const utcTime = ts => { const t = tsMillis(ts); if (!t) return '−−−'; const d = new Date(t); return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC` }
const QUEUE_PAGE = 20
const nFlights = n => `${n} FLIGHT${n === 1 ? '' : 'S'}`

function Stack({ top, bottom, mono = false, strong = false }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
      <span style={{ ...(mono ? monoStyle(12, T.ink) : { fontFamily: T.sans, fontSize: 13, color: T.ink }), fontWeight: strong ? 600 : undefined, whiteSpace: 'nowrap' }}>{top}</span>
      {bottom && <span style={{ ...labelStyle(T.etch), whiteSpace: 'nowrap' }}>{bottom}</span>}
    </span>
  )
}

function QueueStat({ label, value, big }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={labelStyle(T.mutedDark)}>{label}</span>
      <span style={{ ...monoStyle(big ? 30 : 15, T.white), lineHeight: 1 }}>{value}</span>
    </div>
  )
}

const iconBtn = { width: 32, padding: 0, justifyContent: 'center' }

// (22/09) Case à cocher de sélection (attribution groupée) : 16 px, bord 1,5 encre, coche blanche sur encre.
function QCheck({ checked, mixed = false, onChange, label }) {
  return (
    <input type="checkbox" className="ak-focus" aria-label={label} checked={checked}
      ref={el => { if (el) el.indeterminate = mixed && !checked }}
      onChange={e => onChange(e.target.checked)}
      style={{ appearance: 'none', WebkitAppearance: 'none', margin: 0, width: 16, height: 16, flexShrink: 0, cursor: 'pointer', borderRadius: 3,
               border: `1.5px solid ${checked || mixed ? T.ink : T.etch}`, background: checked ? T.ink : mixed ? '#EDE9E2' : T.card,
               backgroundImage: checked ? "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M3.5 8.5 L6.5 11.5 L12.5 4.5' fill='none' stroke='white' stroke-width='2'/%3E%3C/svg%3E\")" : 'none',
               backgroundSize: 'contain' }} />
  )
}

function QueueRow({ f, onAssign, onReplay, sel }) {
  const on = sel.has(f.id)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '16px 84px minmax(120px, 170px) minmax(0, 1fr) 60px 80px auto', alignItems: 'center', gap: 12, padding: '10px 14px', borderTop: '1px solid #EDE9E2', background: on ? '#FBFAF7' : undefined }}>
      <QCheck checked={on} onChange={v => sel.set([f.id], v)} label={`Select the ${utcTime(f.startTs)} flight`} />
      <span style={monoStyle(12, T.ink)}>{utcTime(f.startTs)}</span>
      <span style={monoStyle(12, T.ink)}><Route f={f} /></span>
      <StatusDot tone="caution" text="TO ASSIGN" />
      <span style={{ ...monoStyle(12, T.ink), textAlign: 'right' }}>{formatDuration(f.duration)}</span>
      <span style={{ ...labelStyle(T.etch), textAlign: 'right' }}>{f.maxAlt ? `${Math.round(f.maxAlt)} FT` : '−−−'}</span>
      <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <Button size="sm" variant="primary" onClick={() => onAssign(f)}>Assign</Button>
        <Button size="sm" variant="ghost" icon="play" onClick={() => onReplay(f.id)} title="Open Loop" aria-label="Open Loop" style={iconBtn} />
      </span>
    </div>
  )
}

function AssignQueue({ queue, total, autoCount, acOf, onAssign, onReplay, onReview, sel }) {
  const [shown, setShown] = useState(QUEUE_PAGE)
  const hours = sumDuration(queue)
  if (queue.length <= 3) {
    return (
      <div style={{ background: T.card, border: T.border, borderRadius: T.radius.md, padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, flexWrap: 'wrap' }}>
          <StatusDot tone={queue.length ? 'caution' : 'ok'} text={queue.length ? `${queue.length} TO ASSIGN` : 'QUEUE CLEAR'} />
          <span style={{ fontFamily: T.sans, fontSize: 13, color: T.graphite }}>
            {queue.length ? `${queue.length === 1 ? 'One flight needs' : `${queue.length} flights need`} a pilot by hand.` : 'Every flight has a pilot. Nothing waiting.'}
          </span>
        </span>
        {queue.length > 0 && <Button size="sm" variant="primary" icon="check" onClick={() => onAssign(queue[0])}>{queue.length === 1 ? 'Assign the last one' : 'Assign next flight'}</Button>}
      </div>
    )
  }
  // Groupes jour → avion (plus ancien d'abord), sur les `shown` premiers vols de la file.
  const days = []
  queue.slice(0, shown).forEach(f => {
    const dk = utcDay(f.startTs)
    let d = days.find(x => x.key === dk)
    if (!d) { d = { key: dk, ts: f.startTs, flights: [], groups: [] }; days.push(d) }
    d.flights.push(f)
    const ak = acOf(f).ident
    let g = d.groups.find(x => x.key === ak)
    if (!g) { g = { key: ak, ac: acOf(f), flights: [] }; d.groups.push(g) }
    g.flights.push(f)
  })
  return (
    <section aria-label="Flights to assign" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ background: T.ink, borderRadius: T.radius.md, padding: '18px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
          <QueueStat label="TO ASSIGN" value={queue.length} big />
          <span aria-hidden="true" style={{ width: 1, height: 42, background: T.ruleDark }} />
          <QueueStat label="OLDEST IN QUEUE" value={dayCaps(queue[0].startTs)} />
          <QueueStat label="HOURS UNCREDITED" value={formatDuration(hours)} />
          <QueueStat label="ASSIGNED AUTOMATICALLY" value={`${autoCount} OF ${total}`} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button variant="primary" onInk icon="check" onClick={() => onAssign(queue[0])}>Assign next flight</Button>
          <Button onInk icon="list" onClick={onReview}>Review queue</Button>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, paddingBottom: 8, borderBottom: T.border, flexWrap: 'wrap' }}>
        <h2 style={{ ...headingStyle(15), margin: 0 }}>Queue, by day and aircraft</h2>
        <span style={labelStyle(T.etch)}>GROUPED · OLDEST FIRST</span>
      </div>
      {days.map(d => (
        <div key={d.key} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <QCheck checked={d.flights.every(f => sel.has(f.id))} mixed={d.flights.some(f => sel.has(f.id))}
              onChange={v => sel.set(d.flights.map(f => f.id), v)} label={`Select the ${d.flights.length} flights of ${dayCaps(d.ts)}`} />
            <span style={{ ...labelStyle(T.ink), fontSize: 11 }}>{dayCaps(d.ts)}</span>
            <span style={labelStyle(T.etch)}>{nFlights(d.flights.length)} · {formatDuration(sumDuration(d.flights))}</span>
            <span aria-hidden="true" style={{ flex: 1, height: 1, background: '#EDE9E2' }} />
          </div>
          {d.groups.map(g => (
            <div key={g.key} style={{ background: T.card, border: T.border, borderRadius: T.radius.md, overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', background: '#FBFAF7', flexWrap: 'wrap' }}>
                <QCheck checked={g.flights.every(f => sel.has(f.id))} mixed={g.flights.some(f => sel.has(f.id))}
                  onChange={v => sel.set(g.flights.map(f => f.id), v)} label={`Select the ${g.flights.length} flights of ${g.ac.label}`} />
                {g.ac.rec ? <AircraftPhoto ac={g.ac.rec} width={40} height={30} /> : null}
                <span style={{ ...monoStyle(13, T.ink), fontWeight: 500, letterSpacing: '0.04em' }}>{g.ac.label}</span>
                {g.ac.rec && <Chip muted>{g.ac.rec.ownership === 'owner' ? 'OWNER' : 'CLUB'}</Chip>}
                <span style={labelStyle(T.etch)}>{nFlights(g.flights.length)} · {formatDuration(sumDuration(g.flights))}</span>
              </div>
              {g.flights.map(f => <QueueRow key={f.id} f={f} onAssign={onAssign} onReplay={onReplay} sel={sel} />)}
            </div>
          ))}
        </div>
      ))}
      {queue.length > shown && (
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Button size="sm" onClick={() => setShown(n => n + QUEUE_PAGE)}>Show the next {Math.min(QUEUE_PAGE, queue.length - shown)} in queue</Button>
        </div>
      )}
    </section>
  )
}

function FlightMatrix({ flights, pilots, aircraft, acLabel, acOf, onReplay, onAssign, canDelete, onDelete, autoCount, sel }) {
  const [filterPilot,    setFilterPilot]    = useState('')
  const [filterInstr,    setFilterInstr]    = useState('')
  const [filterAircraft, setFilterAircraft] = useState('')
  const [filterType,     setFilterType]     = useState('')
  const pendingAll = flights.filter(f => f._pending).length
  const [filterStatus,   setFilterStatus]   = useState(pendingAll > 3 ? 'validated' : '')   // la file montre déjà les vols à attribuer
  const [groupBy,        setGroupBy]        = useState('day')    // 'day' | 'aircraft' | 'pilot' | 'none'
  const [sortKey,        setSortKey]        = useState('date')
  const [sortDir,        setSortDir]        = useState('desc')
  const tableRef = useRef(null)

  const instructors = useMemo(() => pilots.filter(p => p.isInstructor === true), [pilots])
  const queue = useMemo(() => flights.filter(f => f._pending).sort((a, b) => tsMillis(a.startTs) - tsMillis(b.startTs)), [flights])

  const filtered = useMemo(() => {
    let list = [...flights]
    if (filterPilot)    list = list.filter(f => f.pilotId === filterPilot)
    if (filterInstr)    list = list.filter(f => f.instructorId === filterInstr)
    if (filterAircraft) list = list.filter(f => acLabel(f.aircraftIdent) === filterAircraft)   // résout legacy 59DWG -> callSign
    if (filterType)     list = list.filter(f => f.flightType === filterType)
    if (filterStatus === 'validated') list = list.filter(f => !f._pending)
    if (filterStatus === 'pending')   list = list.filter(f =>  f._pending)
    const key = f => sortKey === 'duration' ? (f.duration || 0)
      : sortKey === 'aircraft' ? acLabel(f.aircraftIdent)
      : sortKey === 'pilot' ? getPilotName(pilots, f.pilotId)
      : tsMillis(f.startTs)
    list.sort((a, b) => { const va = key(a), vb = key(b); return va < vb ? (sortDir === 'asc' ? -1 : 1) : va > vb ? (sortDir === 'asc' ? 1 : -1) : 0 })
    return list
  }, [flights, filterPilot, filterInstr, filterAircraft, filterType, filterStatus, sortKey, sortDir, acLabel, pilots])

  const groups = useMemo(() => {
    if (groupBy === 'none') return [{ key: 'all', title: null, rows: filtered }]
    const label = f => groupBy === 'aircraft' ? acLabel(f.aircraftIdent) : groupBy === 'pilot' ? getPilotName(pilots, f.pilotId) : dayCaps(f.startTs)
    const out = []
    filtered.forEach(f => { const k = label(f); let g = out.find(x => x.key === k); if (!g) { g = { key: k, title: k, rows: [] }; out.push(g) } g.rows.push(f) })
    return out
  }, [filtered, groupBy, acLabel, pilots])

  const setSort = k => { if (k === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc')); else { setSortKey(k); setSortDir(k === 'date' || k === 'duration' ? 'desc' : 'asc') } }
  const review = () => { setFilterStatus('pending'); setTimeout(() => tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0) }

  const pendingShown = filtered.filter(f => f._pending).map(f => f.id)
  const columns = [
    ...(pendingShown.length ? [{ key: 'sel', width: 28, label: (
      <QCheck checked={pendingShown.every(id => sel.has(id))} mixed={pendingShown.some(id => sel.has(id))}
        onChange={v => sel.set(pendingShown, v)} label={`Select the ${pendingShown.length} flights to assign shown`} />
    ), render: f => (f._pending ? <QCheck checked={sel.has(f.id)} onChange={v => sel.set([f.id], v)} label="Select this flight" /> : null) }] : []),
    { key: 'date', label: 'DATE', render: f => <Stack mono top={formatDate(f.startTs)} bottom={utcTime(f.startTs)} /> },
    { key: 'aircraft', label: 'AIRCRAFT', render: f => <Stack mono top={acLabel(f.aircraftIdent)} bottom={acOf(f).rec?.typeDesig || acOf(f).rec?.type || null} /> },
    { key: 'route', label: 'ROUTE', mono: true, render: f => <Route f={f} /> },
    { key: 'pilot', label: 'PILOT', render: f => <Stack top={f.pilotId ? getPilotName(pilots, f.pilotId) : '—'} bottom={f.pilotRole === 'student' ? 'STUDENT' : f.pilotRole === 'pilot' ? 'PILOT' : null} /> },
    { key: 'kind', label: 'TYPE · INSTRUCTOR', render: f => (
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <TypeBadge type={f.flightType} />
        <span style={{ ...labelStyle(T.etch), whiteSpace: 'nowrap' }}>{f.instructorId ? `${getPilotName(pilots, f.instructorId).toUpperCase()} · ${presenceText(f).toUpperCase()}` : 'NO INSTRUCTOR'}</span>
      </span>
    ) },
    COL_DURATION,
    { key: 'status', label: 'STATUS', render: f => <ValidBadge validated={!f._pending} /> },
    { key: 'actions', label: '', align: 'right', render: f => (
      <RowActions f={f} onReplay={onReplay} onAssign={onAssign} canDelete={canDelete} onDelete={onDelete} />
    ) },
  ]

  const toggle = (active, onClick, label) => <Toggle mono active={active} onClick={onClick}>{label}</Toggle>
  const selectOpts = {
    pilots: pilots.map(p => ({ value: p.id, label: `${p.firstName || ''} ${p.lastName || ''}`.trim() })),
    instr: instructors.map(p => ({ value: p.id, label: `${p.firstName || ''} ${p.lastName || ''}`.trim() })),
    ac: aircraft.map(a => { const cs = a.callSign || a.registration; return { value: cs, label: `${cs} · ${a.typeDesig || a.type || '−'}` } }),
    types: Object.entries(FLIGHT_TYPES).map(([k, v]) => ({ value: k, label: v.label })),
    status: [{ value: '', label: 'Any status' }, { value: 'validated', label: 'Validated' }, { value: 'pending', label: `To assign (${pendingAll})` }],
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <AssignQueue queue={queue} total={flights.length} autoCount={autoCount} acOf={acOf} onAssign={onAssign} onReplay={onReplay} onReview={review} sel={sel} />

      <section ref={tableRef} aria-label="Flights" style={{ display: 'flex', flexDirection: 'column', gap: 12, scrollMarginTop: 16 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, paddingBottom: 8, borderBottom: T.border, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <h2 style={{ ...headingStyle(15), margin: 0 }}>{filterStatus === 'pending' ? 'Flights to assign' : 'Flights'}</h2>
            <span style={labelStyle(T.etch)}>{nFlights(flights.length)} · {pendingAll ? `${pendingAll} TO ASSIGN` : 'ALL ASSIGNED'} · {formatDuration(sumDuration(flights))} TOTAL</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div role="group" aria-label="Group by" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={labelStyle(T.etch)}>GROUP BY</span>
              {toggle(groupBy === 'day', () => setGroupBy('day'), 'DAY')}
              {toggle(groupBy === 'aircraft', () => setGroupBy('aircraft'), 'AIRCRAFT')}
              {toggle(groupBy === 'pilot', () => setGroupBy('pilot'), 'PILOT')}
              {toggle(groupBy === 'none', () => setGroupBy('none'), 'FLAT')}
            </div>
            <div role="group" aria-label="Sort by" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={labelStyle(T.etch)}>SORT</span>
              {toggle(sortKey === 'date', () => setSort('date'), 'DATE')}
              {toggle(sortKey === 'aircraft', () => setSort('aircraft'), 'AIRCRAFT')}
              {toggle(sortKey === 'pilot', () => setSort('pilot'), 'PILOT')}
              {toggle(sortKey === 'duration', () => setSort('duration'), 'DURATION')}
              <Toggle mono onClick={() => setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))} title="Reverse the order">{sortDir === 'asc' ? '↑' : '↓'}</Toggle>
            </div>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
          <Field label="PILOT"><Select value={filterPilot} onChange={setFilterPilot} options={[{ value: '', label: 'All pilots' }, ...selectOpts.pilots]} /></Field>
          <Field label="INSTRUCTOR"><Select value={filterInstr} onChange={setFilterInstr} options={[{ value: '', label: 'All instructors' }, ...selectOpts.instr]} /></Field>
          <Field label="AIRCRAFT"><Select mono value={filterAircraft} onChange={setFilterAircraft} options={[{ value: '', label: 'All aircraft' }, ...selectOpts.ac]} /></Field>
          <Field label="FLIGHT TYPE"><Select value={filterType} onChange={setFilterType} options={[{ value: '', label: 'All types' }, ...selectOpts.types]} /></Field>
          <Field label="STATUS"><Select value={filterStatus} onChange={setFilterStatus} options={selectOpts.status} /></Field>
        </div>

        {groups.length === 0 && <DataTable columns={columns} rows={[]} empty={<EmptyState text="No flights match these filters." />} />}
        {groups.map(g => (
          <div key={g.key} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {g.title && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ ...labelStyle(T.ink), fontSize: 11 }}>{g.title}</span>
                <span style={labelStyle(T.etch)}>{nFlights(g.rows.length)} · {formatDuration(sumDuration(g.rows))}{g.rows.some(f => f._pending) ? ` · ${g.rows.filter(f => f._pending).length} TO ASSIGN` : ''}</span>
                <span aria-hidden="true" style={{ flex: 1, height: 1, background: '#EDE9E2' }} />
              </div>
            )}
            <DataTable columns={columns} rows={g.rows} />
          </div>
        ))}
        <div style={labelStyle(T.etch)}>SHOWING {filtered.length} OF {flights.length}</div>
      </section>
    </div>
  )
}

// ─── MyFlights ────────────────────────────────────────────────────────────────
// Vols du compte connecté (fiche /pilots reliée) : comme pilote (pilotId), et comme instructeur (instructorId) si
// la fiche est instructeur. Lecture seule : « Open Loop » seulement. Métriques avec statut (maquette Claude Design).
function MyFlights({ me, flights, pilots, acLabel, acOf, onReplay }) {
  const total = sumDuration(flights)
  const last  = flights[0]
  const first = flights[flights.length - 1]
  const pending = flights.filter(f => f._pending).length
  const columns = [
    { key: 'date', label: 'DATE', render: f => <Stack mono top={formatDate(f.startTs)} bottom={utcTime(f.startTs)} /> },
    { key: 'aircraft', label: 'AIRCRAFT', render: f => <Stack mono top={acLabel(f.aircraftIdent)} bottom={acOf(f).rec?.typeDesig || acOf(f).rec?.type || null} /> },
    { key: 'route', label: 'ROUTE', mono: true, render: f => <Route f={f} /> },
    ...(me.isInstructor ? [{ key: 'pilot', label: 'PILOT', render: f => <Stack strong={f.pilotId === me.id} top={getPilotName(pilots, f.pilotId)} bottom={f.pilotRole === 'student' ? 'STUDENT' : f.pilotRole === 'pilot' ? 'PILOT' : null} /> }] : []),
    { key: 'kind', label: 'TYPE · INSTRUCTOR', render: f => (
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <TypeBadge type={f.flightType} />
        <span style={{ ...labelStyle(T.etch), whiteSpace: 'nowrap' }}>{f.instructorId ? `${getPilotName(pilots, f.instructorId).toUpperCase()} · ${presenceText(f).toUpperCase()}` : 'NO INSTRUCTOR'}</span>
      </span>
    ) },
    COL_DURATION,
    { key: 'alt', label: 'MAX ALT FT', mono: true, align: 'right', render: f => (f.maxAlt ? Math.round(f.maxAlt) : DASH) },
    { key: 'actions', label: '', align: 'right', render: f => <Button size="sm" variant="ghost" icon="play" onClick={() => onReplay(f.id)}>Open Loop</Button> },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
        <MetricCard label="FLIGHTS" value={String(flights.length)} status={flights.length ? (pending ? { tone: 'caution', text: `${pending} to assign` } : { tone: 'ok', text: 'All validated' }) : undefined} />
        <MetricCard label="HOURS" value={formatDuration(total)} status={first ? { tone: 'off', text: `Since ${formatDate(first.startTs)}` } : undefined} />
        <MetricCard label="LAST FLIGHT" value={last ? formatDate(last.startTs) : null} status={last ? { tone: 'off', text: `${acLabel(last.aircraftIdent)} · ${formatDuration(last.duration)}` } : undefined} />
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, paddingBottom: 8, borderBottom: T.border }}>
        <h2 style={{ ...headingStyle(15), margin: 0 }}>My flights</h2>
        <span style={labelStyle(T.etch)}>{nFlights(flights.length)} · {formatDuration(total)} TOTAL</span>
      </div>
      <DataTable columns={columns} rows={flights} empty={<EmptyState text="No flights recorded yet." />} />
      <div style={labelStyle(T.etch)}>RECORDED BY AKcore · READ ONLY</div>
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

  // (22/09) « Add a flight by hand » (maquette Claude Design) : toute la carte accepte le glisser-déposer.
  return (
    <section id="logbook-import" aria-label="Add a flight by hand"
      onDragOver={e => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); processFile(e.dataTransfer.files[0]) }}
      style={{ background: dragging ? T.paper : T.card, border: `1px ${dragging ? 'dashed' : 'solid'} ${dragging ? T.ink : T.rule}`, borderRadius: T.radius.md, padding: '18px 20px', scrollMarginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
          <h2 style={{ ...headingStyle(15), margin: 0 }}>Add a flight by hand</h2>
          <p style={{ margin: 0, fontFamily: T.sans, fontSize: 13, lineHeight: 1.5, color: T.graphite }}>
            Drop a G3X CSV recorded by the AKcore box. The flight lands in the queue above, ready to assign.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {uploading ? <span style={labelStyle(T.etch)}>UPLOADING · {progress}%</span> : <span style={labelStyle(T.etch)}>G3X CSV · 4 HZ</span>}
          <input ref={inputRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={e => processFile(e.target.files[0])} />
          <Button size="sm" icon="upload" disabled={uploading} onClick={() => inputRef.current?.click()}>Choose a file</Button>
        </div>
      </div>
      {error && <Banner tone="caution" style={{ marginTop: 12 }}>{error}</Banner>}
      {info  && <Banner tone="ok" style={{ marginTop: 12 }}>{info}</Banner>}
    </section>
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
  // Fiche avion d'un vol (photo, type, CLUB/OWNER) : { ident, label, rec }.
  const acOf = useMemo(() => {
    const byIdent = new Map()
    aircraft.forEach(a => { if (a.registration) byIdent.set(a.registration, a); if (a.callSign) byIdent.set(a.callSign, a) })
    return f => { const rec = byIdent.get(f.aircraftIdent) || null; return { ident: rec ? (rec.callSign || rec.registration) : (f.aircraftIdent || '—'), label: rec ? (rec.callSign || rec.registration) : (f.aircraftIdent || 'Unknown aircraft'), rec } }
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

  // La fiche a déjà écrit en base ; onSnapshot rafraîchit la liste. On retient la dernière attribution de la
  // session pour SUGGÉRER le même pilote au vol suivant du même avion le même jour (maquette Claude Design).
  const [suggest, setSuggest] = useState(null)
  // (22/09) Sélection multiple pour l'attribution groupée (ids de vols « to assign »). sel.set(ids, on) coche/décoche.
  const [selIds, setSelIds] = useState(() => new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkMsg, setBulkMsg] = useState('')
  const sel = useMemo(() => ({
    has: id => selIds.has(id),
    set: (ids, on) => setSelIds(prev => { const n = new Set(prev); ids.forEach(id => (on ? n.add(id) : n.delete(id))); return n }),
  }), [selIds])
  const handleAssigned = useCallback((id, u, ctx) => {
    setSuggest({ aircraftIdent: ctx?.aircraftIdent, day: ctx?.day, pilotId: u.pilotId, instructorId: u.instructorId, instructorOnboard: u.instructorOnboard })
  }, [])

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

  const pendingCount  = useMemo(() => flights.filter(f => f._pending).length, [flights])
  const autoCount     = useMemo(() => flights.filter(f => f.autoAssigned).length, [flights])
  const assignQueue   = useMemo(() => flights.filter(f => f._pending).sort((a, b) => tsMillis(a.startTs) - tsMillis(b.startTs)), [flights])
  const selectedFlights = useMemo(() => assignQueue.filter(f => selIds.has(f.id)), [assignQueue, selIds])   // vols déjà attribués retirés d'office
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

        <header style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap', marginBottom: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {clubLine && <div style={labelStyle(T.etch)}>{clubLine}</div>}
            <h1 style={{ ...headingStyle(28), margin: 0 }}>Logbook</h1>
          </div>
          {canImport && (
            <Button size="sm" icon="upload" onClick={() => document.getElementById('logbook-import')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>Import G3X CSV</Button>
          )}
        </header>

        {loadError && (
          <Banner tone="caution" title="Could not load the logbook" style={{ marginBottom: 20 }}>
            {loadError}
          </Banner>
        )}

        {!isPilot && !loading && !loadError && pilots.length === 0 && flights.length === 0 && (
          <div style={{ background: T.card, border: T.border, borderRadius: T.radius.md, padding: 8, marginBottom: 20 }}>
            <EmptyState text="No flights yet. Flights arrive on their own once an AKcore box has flown; you can also add one from a G3X CSV." />
          </div>
        )}

        {!isPilot && !loading && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 24 }}>
            <MetricCard label="PILOTS" value={String(regularPilots.length)}
              status={{ tone: 'off', text: `${regularPilots.filter(p => p.licence === 'student').length} students` }} />
            <MetricCard label="INSTRUCTORS" value={String(instructors.length)}
              status={{ tone: 'off', text: instructors.length === 1 ? `${instructors[0].firstName || ''} ${instructors[0].lastName || ''}`.trim() : (instructors.length ? 'Flight instructors' : 'None flagged') }} />
            <MetricCard label="AIRCRAFT" value={String(aircraft.length)}
              status={{ tone: 'off', text: `${aircraft.filter(a => a.ownership !== 'owner').length} club · ${aircraft.filter(a => a.ownership === 'owner').length} owner` }} />
            <MetricCard label="TOTAL FLIGHTS" value={String(flights.length)}
              status={flights.length ? (pendingCount ? { tone: 'caution', text: `${pendingCount} to assign` } : { tone: 'ok', text: 'All assigned' }) : { tone: 'off', text: 'Nothing recorded' }} />
          </div>
        )}

        {isPilot && !loading && !loadError && !me && (
          <div style={{ background: T.card, border: T.border, borderRadius: T.radius.md, padding: 20, maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 14, marginBottom: 20 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h2 style={{ ...headingStyle(15), margin: 0 }}>Link your account to your pilot record</h2>
              <p style={{ margin: 0, fontFamily: T.sans, fontSize: 13, lineHeight: 1.5, color: T.graphite }}>
                Your flights are already recorded by the AKcore box. Enter the 8-character code your instructor gave you to see them here.
              </p>
            </div>
            <RedeemInvite onDone={() => window.location.reload()} />
          </div>
        )}

        {!(isPilot && !loading && !me) && (
          <Tabs tabs={TABS} value={activeTab} onChange={setTab} ariaLabel="Logbook views" style={{ marginBottom: 20 }} />
        )}

        {loading ? (
          <DataTable loading columns={LOADING_COLUMNS} rows={[]} />
        ) : (
          <>
            {activeTab === 'mine' && me && (
              <MyFlights me={me} flights={myFlights} pilots={pilots} acLabel={acLabel} acOf={acOf} onReplay={handleReplay} />
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
              <FlightMatrix flights={flights} pilots={pilots} aircraft={aircraft} acLabel={acLabel} acOf={acOf} autoCount={autoCount} onReplay={handleReplay} onAssign={handleAssign} canDelete={canDelete} onDelete={handleDelete} sel={sel} />
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

        {canImport && !loading && activeTab !== 'archived' && <div style={{ marginTop: 24 }}><CsvImportCard clubId={clubId} /></div>}

        {bulkMsg && <Banner tone="ok" style={{ marginTop: 16 }} action={<Button size="sm" variant="ghost" onClick={() => setBulkMsg('')}>Dismiss</Button>}>{bulkMsg}</Banner>}
        {!isPilot && activeTab === 'matrix' && selectedFlights.length > 0 && (
          <div role="region" aria-label="Selection" style={{ position: 'sticky', bottom: 16, marginTop: 16, zIndex: 5, background: T.ink, borderRadius: T.radius.md,
                        padding: '12px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
              <span style={{ ...monoStyle(20, T.white), lineHeight: 1 }}>{selectedFlights.length}</span>
              <span style={labelStyle(T.mutedDark)}>SELECTED · {formatDuration(sumDuration(selectedFlights))}</span>
            </span>
            <span style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" onInk variant="ghost" onClick={() => setSelIds(new Set())}>Clear</Button>
              <Button size="sm" onInk variant="primary" icon="check" onClick={() => setBulkOpen(true)}>Assign {selectedFlights.length} flight{selectedFlights.length === 1 ? '' : 's'}</Button>
            </span>
          </div>
        )}
      </div>

      {bulkOpen && selectedFlights.length > 0 && (
        <BulkAssignDrawer flights={selectedFlights} pilots={pilots} aircraft={aircraft}
          onClose={() => setBulkOpen(false)}
          onDone={n => { setSelIds(new Set()); setBulkMsg(`${n} flight${n === 1 ? '' : 's'} assigned and validated.`) }} />
      )}

      {assignFlight && (
        <FlightAssignModal
          key={assignFlight.id}            // (22/09) « Save & next flight » : état ré-initialisé à chaque vol
          flight={assignFlight}
          pilots={pilots}
          aircraft={aircraft}
          onSave={handleAssigned}
          onClose={() => setAssignFlight(null)}
          queue={assignFlight._pending ? assignQueue : []}
          onNext={f => setAssignFlight(f)}
          onOpenLoop={handleReplay}
          suggest={suggest}
        />
      )}
    </div>
  )
}
