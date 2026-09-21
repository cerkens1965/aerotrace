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

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { collection, getDocs, query, where, doc, updateDoc, addDoc, onSnapshot, serverTimestamp } from 'firebase/firestore'
import { ref, uploadBytesResumable } from 'firebase/storage'
import { db, storage, auth } from '../firebase/config'
import { parseG3XCSV } from '../utils/csvParser'
import { useNavigate, useLocation } from 'react-router-dom'
import { useClub } from '../contexts/ClubContext'
import FlightAssignModal from '../components/logbook/FlightAssignModal'
import RedeemInvite from '../components/auth/RedeemInvite'
import {
  formatDate, formatDateTime, formatDuration, sortByDateDesc, tsMillis, icaoFlag, icaoCountry,
  FLIGHT_TYPES, getPilotName, sumDuration, flightTypeBadge, needsAssignment, findMyPilot,
} from '../utils/logbookUtils'

// Rôles autorisés à importer un CSV depuis le Logbook.
const IMPORT_ROLES = ['instructor', 'admin', 'super_admin']

// ─── Shared low-level components ──────────────────────────────────────────────

function StatCard({ label, value, accent = false }) {
  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid rgba(10,14,30,0.12)',
      borderRadius: 8,
      padding: '12px 18px',
    }}>
      <div style={{ color: 'rgba(10,14,30,0.50)', fontSize: 10, letterSpacing: 1.5 }}>{label}</div>
      <div style={{ color: accent ? '#F5A623' : '#0a0e1e', fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  )
}

function TypeBadge({ type }) {
  const b = flightTypeBadge(type)
  if (!b) return <span style={{ color: 'rgba(10,14,30,0.35)' }}>—</span>
  return (
    <span style={{
      background: `${b.color}18`,
      border: `1px solid ${b.color}44`,
      color: b.color,
      fontFamily: 'monospace',
      fontSize: 10,
      padding: '2px 8px',
      borderRadius: 4,
      letterSpacing: 0.5,
      whiteSpace: 'nowrap',
    }}>
      {b.label}
    </span>
  )
}

function ValidBadge({ validated }) {
  return (
    <span style={{
      background: validated ? 'rgba(34,197,94,0.08)' : 'rgba(245,166,35,0.08)',
      border: `1px solid ${validated ? 'rgba(34,197,94,0.25)' : 'rgba(245,166,35,0.25)'}`,
      color: validated ? '#22c55e' : '#F5A623',
      fontSize: 10,
      padding: '2px 7px',
      borderRadius: 4,
      fontFamily: 'monospace',
      whiteSpace: 'nowrap',
    }}>
      {validated ? '✓ OK' : '⚠ To assign'}
    </span>
  )
}

/**
 * Terrain (OACI) + drapeau de son pays. `icao` null → tiret : normalizeFlight n'a
 * trouvé aucun terrain à moins de 5 km du 1er/dernier point GPS (hors base AIP, ou
 * log qui ne démarre pas au sol). On préfère l'aveu au terrain faux.
 * Le drapeau ne s'affiche pas sous Windows (pas de police) → les 2 lettres du pays
 * apparaissent à la place, ce qui reste lisible.
 */
function Airfield({ icao }) {
  if (!icao) return <span style={{ color: 'rgba(10,14,30,0.30)' }}>—</span>
  const flag = icaoFlag(icao)
  return (
    <span title={icaoCountry(icao) || 'unknown country'} style={{ color: '#0a0e1e' }}>
      {flag && <span style={{ marginRight: 4 }}>{flag}</span>}{icao}
    </span>
  )
}

const TH = { textAlign: 'left', padding: '5px 10px', fontWeight: 400, fontSize: 10, letterSpacing: 1.5, color: 'rgba(10,14,30,0.45)', whiteSpace: 'nowrap' }
const TD = { padding: '9px 10px', color: '#0a0e1e', fontFamily: 'monospace', fontSize: 12, verticalAlign: 'middle' }
const REPLAY_BTN = {
  background: 'rgba(245,166,35,0.1)', border: '1px solid rgba(245,166,35,0.3)',
  color: '#F5A623', fontFamily: 'monospace', fontSize: 11, padding: '3px 10px',
  borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
}
const ASSIGN_BTN = {
  background: 'rgba(96,165,250,0.1)', border: '1px solid rgba(96,165,250,0.3)',
  color: '#60a5fa', fontFamily: 'monospace', fontSize: 11, padding: '3px 10px',
  borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
}
const DEL_BTN = {
  background: 'transparent', border: '1px solid rgba(239,68,68,0.3)',
  color: 'rgba(239,68,68,0.85)', fontFamily: 'monospace', fontSize: 11,
  padding: '3px 9px', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
}
// (édition) Ré-attribution d'un vol DÉJÀ validé — neutre, à côté de REPLAY.
const EDIT_BTN = {
  background: 'rgba(10,14,30,0.05)', border: '1px solid rgba(10,14,30,0.18)',
  color: 'rgba(10,14,30,0.6)', fontFamily: 'monospace', fontSize: 11,
  padding: '3px 9px', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap',
}
const DEL_CONFIRM_BTN = {
  ...DEL_BTN, background: '#ef4444', border: '1px solid #ef4444', color: '#fff', fontWeight: 700,
}
const CARD_STYLE = { background: '#ffffff', borderRadius: 8, overflow: 'hidden' }

// ─── PilotCard ────────────────────────────────────────────────────────────────

// Badge propriété avion — CLUB (rouge, = highlight carte live) / OWNER (bleu).
function OwnershipBadge({ ac }) {
  const isOwner = ac?.ownership === 'owner'
  return (
    <span style={{
      fontFamily: 'monospace', fontSize: 8, fontWeight: 700, letterSpacing: '0.05em',
      padding: '2px 6px', borderRadius: 4,
      background: isOwner ? 'rgba(96,165,250,0.10)' : 'rgba(239,68,68,0.10)',
      color: isOwner ? '#3b82f6' : '#ef4444',
      border: `1px solid ${isOwner ? 'rgba(96,165,250,0.35)' : 'rgba(239,68,68,0.35)'}`,
    }}>{isOwner ? 'OWNER' : 'CLUB'}</span>
  )
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

  return (
    <div style={{
      ...CARD_STYLE,
      border: `1px solid ${open ? 'rgba(245,166,35,0.3)' : 'rgba(10,14,30,0.10)'}`,
      transition: 'border-color 0.2s',
    }}>
      <div
        onClick={() => setOpen(v => !v)}
        style={{ display: 'grid', gridTemplateColumns: '1fr repeat(3, auto)', gap: 20, padding: '14px 20px', cursor: 'pointer', alignItems: 'center' }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: '#0a0e1e', fontFamily: 'monospace', fontSize: 14, fontWeight: 600 }}>
              {pilot.firstName} {pilot.lastName}
            </span>
            {unvalidated > 0 && (
              <span style={{ color: '#F5A623', fontSize: 10, background: 'rgba(245,166,35,0.1)', border: '1px solid rgba(245,166,35,0.2)', padding: '1px 6px', borderRadius: 3 }}>
                {unvalidated} to assign
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 5, marginTop: 5, flexWrap: 'wrap', alignItems: 'center' }}>
            {(pilot.licences || []).map(lic => (
              <span key={lic} style={{ background: 'rgba(10,14,30,0.06)', border: '1px solid rgba(10,14,30,0.15)', color: '#0a0e1e', fontSize: 10, fontFamily: 'monospace', padding: '1px 6px', borderRadius: 3 }}>{lic}</span>
            ))}
            {counterparts.length > 0 && (
              <span style={{ color: 'rgba(10,14,30,0.45)', fontSize: 11, fontFamily: 'monospace' }}>
                {mode === 'pilot' ? 'with:' : 'students:'} {counterparts.slice(0, 2).join(', ')}{counterparts.length > 2 ? ` +${counterparts.length - 2}` : ''}
              </span>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: 'rgba(10,14,30,0.45)', fontSize: 10, letterSpacing: 1.5 }}>TOTAL</div>
          <div style={{ color: '#0a0e1e', fontFamily: 'monospace', fontSize: 17, fontWeight: 700, marginTop: 2 }}>{formatDuration(total)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: 'rgba(10,14,30,0.45)', fontSize: 10, letterSpacing: 1.5 }}>FLIGHTS</div>
          <div style={{ color: '#0a0e1e', fontFamily: 'monospace', fontSize: 17, fontWeight: 700, marginTop: 2 }}>{myFlights.length}</div>
          {mode === 'instructor' && myFlights.length > 0 && (
            <div style={{ color: 'rgba(10,14,30,0.50)', fontSize: 10, marginTop: 2 }}>{onboard.length}✈ {fromGround.length}📡</div>
          )}
        </div>
        <div style={{ textAlign: 'right', minWidth: 118 }}>
          <div style={{ color: 'rgba(10,14,30,0.45)', fontSize: 10, letterSpacing: 1.5 }}>LAST FLIGHT</div>
          <div style={{ color: 'rgba(10,14,30,0.80)', fontFamily: 'monospace', fontSize: 11, marginTop: 2 }}>{last ? formatDate(last.startTs) : '—'}</div>
          {last && <TypeBadge type={last.flightType} />}
        </div>
      </div>

      {open && mode === 'pilot' && Object.keys(byType).length > 0 && (
        <div style={{ borderTop: '1px solid rgba(10,14,30,0.07)', padding: '10px 20px', display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          {Object.entries(byType).map(([type, secs]) => {
            const ft = FLIGHT_TYPES[type]
            if (!ft) return null
            return (
              <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: ft.color, flexShrink: 0 }} />
                <span style={{ color: ft.color, fontFamily: 'monospace', fontSize: 11 }}>{ft.label}</span>
                <span style={{ color: 'rgba(10,14,30,0.75)', fontFamily: 'monospace', fontSize: 11 }}>{formatDuration(secs)}</span>
              </div>
            )
          })}
        </div>
      )}

      {open && myFlights.length > 0 && (
        <div style={{ borderTop: '1px solid rgba(10,14,30,0.07)', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace' }}>
            <thead>
              <tr>
                <th style={TH}>DATE</th>
                <th style={TH}>AIRCRAFT</th>
                {mode === 'instructor' && <th style={TH}>STUDENT</th>}
                {mode === 'pilot' && <th style={TH}>INSTRUCTOR</th>}
                <th style={TH}>DURATION</th>
                <th style={TH}>TYPE</th>
                {mode === 'instructor' && <th style={TH}>PRESENCE</th>}
                <th style={TH}>ALT MAX</th>
                <th style={TH}>G MAX</th>
                <th style={TH}></th>
              </tr>
            </thead>
            <tbody>
              {myFlights.map((f, i) => (
                <tr key={f.id} style={{ borderTop: '1px solid rgba(10,14,30,0.06)', background: i % 2 === 0 ? 'transparent' : 'rgba(10,14,30,0.02)' }}>
                  <td style={{ ...TD, color: 'rgba(10,14,30,0.75)', fontSize: 11 }}>{formatDateTime(f.startTs)}</td>
                  <td style={{ ...TD, color: '#0a0e1e' }} title={f.aircraftIdent || ''}>{acLabel ? acLabel(f.aircraftIdent) : (f.aircraftIdent || '—')}</td>
                  {mode === 'instructor' && <td style={TD}>{getPilotName(pilots, f.pilotId)}</td>}
                  {mode === 'pilot' && <td style={{ ...TD, color: 'rgba(10,14,30,0.70)' }}>{f.instructorId ? getPilotName(pilots, f.instructorId) : '—'}</td>}
                  <td style={TD}>{formatDuration(f.duration)}</td>
                  <td style={TD}><TypeBadge type={f.flightType} /></td>
                  {mode === 'instructor' && (
                    <td style={{ ...TD, color: 'rgba(10,14,30,0.65)', fontSize: 11 }}>
                      {f.instructorOnboard ? '🪑 on board' : '📡 on ground'}
                    </td>
                  )}
                  <td style={{ ...TD, color: 'rgba(10,14,30,0.70)' }}>{f.maxAlt ? `${Math.round(f.maxAlt)} ft` : '—'}</td>
                  <td style={{ ...TD, color: f.maxG > 2.5 ? '#ef4444' : 'rgba(10,14,30,0.70)' }}>{f.maxG ? `${f.maxG.toFixed(1)}G` : '—'}</td>
                  <td style={{ ...TD, textAlign: 'right', paddingRight: 16 }}>
                    <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button onClick={() => onReplay(f.id)} style={REPLAY_BTN}>Open Loop</button>
                      {!f._pending
                        ? <button onClick={() => onAssign(f)} style={EDIT_BTN} title="Edit assignment">✏ Edit</button>
                        : <button onClick={() => onAssign(f)} style={ASSIGN_BTN}>✏ Assign</button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && myFlights.length === 0 && (
        <div style={{ borderTop: '1px solid rgba(10,14,30,0.07)', padding: '20px', color: 'rgba(10,14,30,0.35)', fontFamily: 'monospace', fontSize: 13, textAlign: 'center' }}>No flights recorded</div>
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

  return (
    <div style={{ ...CARD_STYLE, border: `1px solid ${open ? 'rgba(245,166,35,0.3)' : 'rgba(10,14,30,0.10)'}`, transition: 'border-color 0.2s' }}>
      <div onClick={() => setOpen(v => !v)} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr repeat(4, auto)', gap: 16, padding: '14px 20px', cursor: 'pointer', alignItems: 'center' }}>
        <div style={{ width: 42, height: 42, background: 'rgba(245,166,35,0.07)', border: '1px solid rgba(245,166,35,0.17)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>✈</div>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#0a0e1e', fontFamily: 'monospace', fontSize: 16, fontWeight: 700 }}>{ac.callSign || ac.registration}</span>
            <OwnershipBadge ac={ac} />
          </div>
          <div style={{ color: 'rgba(10,14,30,0.5)', fontFamily: 'monospace', fontSize: 11, marginTop: 2 }}>{[ac.ownership === 'owner' ? `👤 ${getPilotName(pilots, ac.ownerPilotId)}` : null, ac.typeDesig || ac.type, ac.icao24?.toUpperCase()].filter(Boolean).join(' · ')}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
            {Object.entries(byType).map(([type, cnt]) => {
              const ft = FLIGHT_TYPES[type]
              return ft ? <span key={type} style={{ color: ft.color, fontSize: 10, fontFamily: 'monospace' }}>{cnt}× {ft.label}</span> : null
            })}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: 'rgba(10,14,30,0.45)', fontSize: 10, letterSpacing: 1.5 }}>TOTAL</div>
          <div style={{ color: '#0a0e1e', fontFamily: 'monospace', fontSize: 17, fontWeight: 700, marginTop: 2 }}>{formatDuration(total)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: 'rgba(10,14,30,0.45)', fontSize: 10, letterSpacing: 1.5 }}>FLIGHTS</div>
          <div style={{ color: '#0a0e1e', fontFamily: 'monospace', fontSize: 17, fontWeight: 600, marginTop: 2 }}>{acFlights.length}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: 'rgba(10,14,30,0.45)', fontSize: 10, letterSpacing: 1.5 }}>PILOTS</div>
          <div style={{ color: '#0a0e1e', fontFamily: 'monospace', fontSize: 17, fontWeight: 600, marginTop: 2 }}>{uniquePilots}</div>
        </div>
        <div style={{ textAlign: 'right', minWidth: 110 }}>
          <div style={{ color: 'rgba(10,14,30,0.45)', fontSize: 10, letterSpacing: 1.5 }}>LAST FLIGHT</div>
          <div style={{ color: 'rgba(10,14,30,0.80)', fontFamily: 'monospace', fontSize: 11, marginTop: 2 }}>{last ? formatDate(last.startTs) : '—'}</div>
          {lastPilot && <div style={{ color: 'rgba(10,14,30,0.55)', fontFamily: 'monospace', fontSize: 11 }}>{lastPilot}</div>}
        </div>
      </div>

      {open && acFlights.length > 0 && (
        <div style={{ borderTop: '1px solid rgba(10,14,30,0.07)', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace' }}>
            <thead><tr>
              <th style={TH}>DATE</th><th style={TH}>PILOT</th><th style={TH}>INSTRUCTOR</th>
              <th style={TH}>DURATION</th><th style={TH}>TYPE</th><th style={TH}>ALT MAX</th><th style={TH}>G MAX</th><th style={TH}></th>
            </tr></thead>
            <tbody>
              {acFlights.map((f, i) => (
                <tr key={f.id} style={{ borderTop: '1px solid rgba(10,14,30,0.06)', background: i % 2 === 0 ? 'transparent' : 'rgba(10,14,30,0.02)' }}>
                  <td style={{ ...TD, color: 'rgba(10,14,30,0.75)', fontSize: 11 }}>{formatDateTime(f.startTs)}</td>
                  <td style={TD}>{getPilotName(pilots, f.pilotId)}</td>
                  <td style={{ ...TD, color: 'rgba(10,14,30,0.65)' }}>
                    {f.instructorId ? `${getPilotName(pilots, f.instructorId)} ${f.instructorOnboard ? '🪑' : '📡'}` : '—'}
                  </td>
                  <td style={TD}>{formatDuration(f.duration)}</td>
                  <td style={TD}><TypeBadge type={f.flightType} /></td>
                  <td style={{ ...TD, color: 'rgba(10,14,30,0.70)' }}>{f.maxAlt ? `${Math.round(f.maxAlt)} ft` : '—'}</td>
                  <td style={{ ...TD, color: f.maxG > 2.5 ? '#ef4444' : 'rgba(10,14,30,0.70)' }}>{f.maxG ? `${f.maxG.toFixed(1)}G` : '—'}</td>
                  <td style={{ ...TD, textAlign: 'right', paddingRight: 16 }}>
                    <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button onClick={() => onReplay(f.id)} style={REPLAY_BTN}>Open Loop</button>
                      {!f._pending
                        ? <button onClick={() => onAssign(f)} style={EDIT_BTN} title="Edit assignment">✏ Edit</button>
                        : <button onClick={() => onAssign(f)} style={ASSIGN_BTN}>✏ Assign</button>}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && acFlights.length === 0 && (
        <div style={{ borderTop: '1px solid rgba(10,14,30,0.07)', padding: '20px', color: 'rgba(10,14,30,0.35)', fontFamily: 'monospace', fontSize: 13, textAlign: 'center' }}>No flights for this aircraft</div>
      )}
    </div>
  )
}

// ─── FlightMatrix ─────────────────────────────────────────────────────────────

function FlightMatrix({ flights, pilots, aircraft, acLabel, onReplay, onAssign, canDelete, onDelete }) {
  const [confirmDelId,   setConfirmDelId]   = useState('')   // 2 temps : 1er clic arme, 2e archive
  // Désarme automatiquement après 5 s (pas de dépendance au survol → pas de course).
  useEffect(() => {
    if (!confirmDelId) return
    const t = setTimeout(() => setConfirmDelId(''), 5000)
    return () => clearTimeout(t)
  }, [confirmDelId])
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

  const SortTH = ({ children, skey }) => (
    <th onClick={() => toggleSort(skey)} style={{ ...TH, cursor: 'pointer', userSelect: 'none' }}>
      {children}{sortKey === skey ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
    </th>
  )

  const selectStyle = {
    background: 'rgba(10,14,30,0.07)', border: '1px solid rgba(255,255,255,0.1)',
    color: '#0a0e1e', fontFamily: 'monospace', fontSize: 12, padding: '6px 10px',
    borderRadius: 5, outline: 'none', cursor: 'pointer',
  }

  const pendingCount = flights.filter(f => f._pending).length

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
        <select value={filterPilot} onChange={e => setFilterPilot(e.target.value)} style={selectStyle}>
          <option value="">All pilots</option>
          {pilots.map(p => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
        </select>
        <select value={filterInstr} onChange={e => setFilterInstr(e.target.value)} style={selectStyle}>
          <option value="">All instructors</option>
          {instructors.map(p => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
        </select>
        <select value={filterAircraft} onChange={e => setFilterAircraft(e.target.value)} style={selectStyle}>
          <option value="">All aircraft</option>
          {aircraft.map(a => { const cs = a.callSign || a.registration; return <option key={a.id} value={cs}>{cs} — {a.typeDesig || a.type}</option> })}
        </select>
        <select value={filterType} onChange={e => setFilterType(e.target.value)} style={selectStyle}>
          <option value="">All types</option>
          {Object.entries(FLIGHT_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          <option value="validated">Validated</option>
          <option value="pending">To assign ({pendingCount})</option>
        </select>
        <span style={{ color: 'rgba(10,14,30,0.45)', fontFamily: 'monospace', fontSize: 12, marginLeft: 'auto' }}>
          {filtered.length} flight{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div style={{ ...CARD_STYLE, border: '1px solid rgba(10,14,30,0.12)', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace' }}>
          <thead style={{ borderBottom: '1px solid rgba(10,14,30,0.10)' }}>
            <tr>
              <SortTH skey="date">DATE</SortTH>
              <SortTH skey="aircraft">AIRCRAFT</SortTH>
              <th style={TH}>ROUTE</th>
              <th style={TH}>PILOT</th>
              <th style={TH}>ROLE</th>
              <th style={TH}>INSTRUCTOR</th>
              <th style={TH}>PRESENCE</th>
              <SortTH skey="duration">DURATION</SortTH>
              <th style={TH}>TYPE</th>
              <th style={TH}>ALT MAX</th>
              <th style={TH}>STATUS</th>
              <th style={TH}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={12} style={{ ...TD, textAlign: 'center', padding: '32px', color: 'rgba(10,14,30,0.35)' }}>No matching flights</td></tr>
            )}
            {filtered.map((f, i) => (
              <tr key={f.id} style={{
                borderTop: '1px solid rgba(10,14,30,0.07)',
                background: f._pending ? 'rgba(245,166,35,0.02)' : i % 2 === 0 ? 'transparent' : 'rgba(10,14,30,0.02)',
              }}>
                <td style={{ ...TD, color: 'rgba(10,14,30,0.75)', fontSize: 11 }}>{formatDateTime(f.startTs)}</td>
                <td style={{ ...TD, color: '#0a0e1e' }} title={f.aircraftIdent || ''}>{acLabel(f.aircraftIdent)}</td>
                {/* Terrains déduits du GPS (normalizeFlight). '—' = aucun terrain connu à
                    moins de 5 km : soit hors base AIP, soit le log ne démarre pas au sol. */}
                <td style={{ ...TD, color: 'rgba(10,14,30,0.70)', fontSize: 11, whiteSpace: 'nowrap' }}>
                  {(f.depIcao || f.arrIcao)
                    ? <><Airfield icao={f.depIcao} />
                        <span style={{ color: 'rgba(10,14,30,0.35)' }}> → </span>
                        <Airfield icao={f.arrIcao} /></>
                    : <span style={{ color: 'rgba(10,14,30,0.30)' }}>—</span>}
                </td>
                <td style={TD}>{getPilotName(pilots, f.pilotId)}</td>
                <td style={TD}>
                  {f.pilotRole === 'student'
                    ? <span style={{ color: '#60a5fa', fontSize: 11 }}>🎓 STUDENT</span>
                    : f.pilotRole === 'pilot'
                    ? <span style={{ color: 'rgba(10,14,30,0.70)', fontSize: 11 }}>✈ PILOT</span>
                    : <span style={{ color: 'rgba(10,14,30,0.35)', fontSize: 11 }}>—</span>}
                </td>
                <td style={{ ...TD, color: 'rgba(10,14,30,0.70)' }}>{f.instructorId ? getPilotName(pilots, f.instructorId) : '—'}</td>
                <td style={{ ...TD, color: 'rgba(10,14,30,0.60)', fontSize: 11 }}>
                  {f.instructorId ? (f.instructorOnboard ? '🪑 on board' : '📡 on ground') : '—'}
                </td>
                <td style={TD}>{formatDuration(f.duration)}</td>
                <td style={TD}><TypeBadge type={f.flightType} /></td>
                <td style={{ ...TD, color: 'rgba(10,14,30,0.70)' }}>{f.maxAlt ? `${Math.round(f.maxAlt)} ft` : '—'}</td>
                <td style={TD}><ValidBadge validated={!f._pending} /></td>
                <td style={{ ...TD, textAlign: 'right', paddingRight: 16 }}>
                  <span style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                    <button onClick={() => onReplay(f.id)} style={REPLAY_BTN}>Open Loop</button>
                    {!f._pending
                      ? <button onClick={() => onAssign(f)} style={EDIT_BTN} title="Edit assignment">✏ Edit</button>
                      : <button onClick={() => onAssign(f)} style={ASSIGN_BTN}>✏ Assign</button>}
                    {canDelete && (
                      confirmDelId === f.id
                        ? <button onClick={() => { onDelete(f.id); setConfirmDelId('') }}
                                  style={DEL_CONFIRM_BTN}>Confirm?</button>
                        : <button onClick={() => setConfirmDelId(f.id)} title="Remove this flight from the logbook"
                                  style={DEL_BTN}>Delete</button>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
        <StatCard label="FLIGHTS"     value={flights.length} />
        <StatCard label="HOURS"       value={formatDuration(total)} accent />
        <StatCard label="LAST FLIGHT" value={last ? formatDate(last.startTs) : '—'} />
      </div>

      <div style={{ ...CARD_STYLE, border: '1px solid rgba(10,14,30,0.12)', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace' }}>
          <thead style={{ borderBottom: '1px solid rgba(10,14,30,0.10)' }}>
            <tr>
              <th style={TH}>DATE</th>
              <th style={TH}>AIRCRAFT</th>
              <th style={TH}>ROUTE</th>
              <th style={TH}>PILOT</th>
              <th style={TH}>INSTRUCTOR</th>
              <th style={TH}>DURATION</th>
              <th style={TH}>TYPE</th>
              <th style={TH}>ALT MAX</th>
              <th style={TH}>G MAX</th>
              <th style={TH}></th>
            </tr>
          </thead>
          <tbody>
            {flights.length === 0 && (
              <tr><td colSpan={10} style={{ ...TD, textAlign: 'center', padding: '32px', color: 'rgba(10,14,30,0.35)' }}>No flights recorded yet</td></tr>
            )}
            {flights.map((f, i) => (
              <tr key={f.id} style={{ borderTop: '1px solid rgba(10,14,30,0.07)', background: i % 2 === 0 ? 'transparent' : 'rgba(10,14,30,0.02)' }}>
                <td style={{ ...TD, color: 'rgba(10,14,30,0.75)', fontSize: 11 }}>{formatDateTime(f.startTs)}</td>
                <td style={{ ...TD, color: '#0a0e1e' }} title={f.aircraftIdent || ''}>{acLabel(f.aircraftIdent)}</td>
                <td style={{ ...TD, color: 'rgba(10,14,30,0.70)', fontSize: 11, whiteSpace: 'nowrap' }}>
                  {(f.depIcao || f.arrIcao)
                    ? <><Airfield icao={f.depIcao} />
                        <span style={{ color: 'rgba(10,14,30,0.35)' }}> → </span>
                        <Airfield icao={f.arrIcao} /></>
                    : <span style={{ color: 'rgba(10,14,30,0.30)' }}>—</span>}
                </td>
                <td style={{ ...TD, fontWeight: f.pilotId === me.id ? 700 : 400 }}>{getPilotName(pilots, f.pilotId)}</td>
                <td style={{ ...TD, color: 'rgba(10,14,30,0.70)', fontWeight: f.instructorId === me.id ? 700 : 400 }}>
                  {f.instructorId ? `${getPilotName(pilots, f.instructorId)} ${f.instructorOnboard ? '🪑' : '📡'}` : '—'}
                </td>
                <td style={TD}>{formatDuration(f.duration)}</td>
                <td style={TD}><TypeBadge type={f.flightType} /></td>
                <td style={{ ...TD, color: 'rgba(10,14,30,0.70)' }}>{f.maxAlt ? `${Math.round(f.maxAlt)} ft` : '—'}</td>
                <td style={{ ...TD, color: f.maxG > 2.5 ? '#ef4444' : 'rgba(10,14,30,0.70)' }}>{f.maxG ? `${f.maxG.toFixed(1)}G` : '—'}</td>
                <td style={{ ...TD, textAlign: 'right', paddingRight: 16 }}>
                  <button onClick={() => onReplay(f.id)} style={REPLAY_BTN}>Open Loop</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
    <div style={{ ...CARD_STYLE, border: '1px solid rgba(10,14,30,0.12)', padding: '14px 20px', marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ color: 'rgba(10,14,30,0.5)', fontSize: 10, letterSpacing: 1.5 }}>IMPORT CSV</div>
        <div
          onClick={() => !uploading && inputRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); processFile(e.dataTransfer.files[0]) }}
          style={{
            flex: 1, minWidth: 220,
            border: `1px dashed ${dragging ? '#F5A623' : 'rgba(10,14,30,0.2)'}`,
            background: dragging ? 'rgba(245,166,35,0.06)' : 'transparent',
            borderRadius: 6, padding: '10px 14px', textAlign: 'center',
            color: 'rgba(10,14,30,0.55)', fontFamily: 'monospace', fontSize: 12,
            cursor: uploading ? 'wait' : 'pointer', transition: 'all 0.15s',
          }}
        >
          {uploading ? `Uploading… ${progress}%` : 'Drop a Garmin G3X CSV here'}
        </div>
        <input ref={inputRef} type="file" accept=".csv" style={{ display: 'none' }}
          onChange={e => processFile(e.target.files[0])} />
        <button type="button" disabled={uploading} onClick={() => inputRef.current?.click()} style={{ ...ASSIGN_BTN, cursor: uploading ? 'wait' : 'pointer' }}>
          Choose file
        </button>
      </div>
      {error && <div style={{ color: '#ef4444', fontFamily: 'monospace', fontSize: 11, marginTop: 8 }}>⚠ {error}</div>}
      {info  && <div style={{ color: '#22c55e', fontFamily: 'monospace', fontSize: 11, marginTop: 8 }}>✓ {info}</div>}
    </div>
  )
}

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
        setRawFlights(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(f => f.archived !== true))
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

  // ── Sort bar component ────────────────────────────────────────────────────────
  const SortBar = ({ value, onChange, options }) => (
    <div style={{ display: 'flex', gap: 6, marginBottom: 14, alignItems: 'center' }}>
      <span style={{ color: 'rgba(10,14,30,0.4)', fontSize: 10, letterSpacing: 1.2, marginRight: 4 }}>SORT BY</span>
      {options.map(opt => (
        <button key={opt.key} onClick={() => onChange(opt.key)} style={{
          background: value === opt.key ? 'rgba(10,14,30,0.08)' : 'transparent',
          border: `1px solid ${value === opt.key ? 'rgba(10,14,30,0.25)' : 'rgba(10,14,30,0.1)'}`,
          color: value === opt.key ? '#0a0e1e' : 'rgba(10,14,30,0.45)',
          fontFamily: 'monospace', fontSize: 11, fontWeight: value === opt.key ? 700 : 400,
          padding: '4px 12px', borderRadius: 5, cursor: 'pointer', transition: 'all 0.15s',
        }}>
          {opt.label}
        </button>
      ))}
    </div>
  )

  const PILOT_SORTS    = [{ key: 'alpha', label: 'A→Z' }, { key: 'lastFlight', label: 'Last flight' }, { key: 'hours', label: 'Hours ↓' }]
  const AIRCRAFT_SORTS = [{ key: 'alpha', label: 'A→Z' }, { key: 'lastFlight', label: 'Last flight' }, { key: 'hours', label: 'Hours ↓' }]

  const TABS = isPilot ? [
    { key: 'mine',        label: `My flights (${myFlights.length})` },
  ] : [
    ...(me ? [{ key: 'mine', label: `My flights (${myFlights.length})` }] : []),
    { key: 'pilots',      label: `👤 Pilots (${regularPilots.length})` },
    { key: 'instructors', label: `🎓 Instructors (${instructors.length})` },
    { key: 'aircraft',    label: `✈ Aircraft (${aircraft.length})` },
    { key: 'matrix',      label: pendingCount > 0 ? `⚠ All flights  ${pendingCount} to assign` : '☰ All flights' },
  ]

  const clubLine = [club?.name, club?.icao, new Date().getFullYear()].filter(Boolean).join(' · ')

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: '#f0f2f8', fontFamily: 'monospace' }}>
      <div style={{ padding: '80px 32px 48px', maxWidth: 1280, margin: '0 auto' }}>

        <div style={{ marginBottom: 28 }}>
          <div style={{ color: 'rgba(10,14,30,0.5)', fontSize: 10, letterSpacing: 2.5, marginBottom: 6 }}>
            {clubLine}
          </div>
          <h1 style={{ color: '#0a0e1e', fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: 1 }}>Logbook</h1>
        </div>

        {loadError && (
          <div style={{
            background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.4)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 20,
            color: '#ef4444', fontFamily: 'monospace', fontSize: 12,
          }}>
            ❌ Could not load the logbook: {loadError}
          </div>
        )}

        {!isPilot && !loading && !loadError && pilots.length === 0 && flights.length === 0 && (
          <div style={{
            background: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.3)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 20,
            color: '#F5A623', fontFamily: 'monospace', fontSize: 12,
          }}>
            No data for this club yet.
          </div>
        )}

        {!isPilot && !loading && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 24 }}>
            <StatCard label="PILOTS"              value={regularPilots.length} />
            <StatCard label="INSTRUCTORS"         value={instructors.length} />
            <StatCard label="AIRCRAFT"            value={aircraft.length} />
            <StatCard label="TOTAL FLIGHTS"       value={flights.length} />
            <StatCard label="TOTAL HOURS"         value={formatDuration(totalSeconds)} accent />
          </div>
        )}

        {canImport && <CsvImportCard clubId={clubId} />}

        {isPilot && !loading && !loadError && !me && (
          <div style={{
            background: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.3)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 20,
            color: '#0a0e1e', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6,
          }}>
            <div style={{ marginBottom: 12 }}>
              Your account is not linked to a pilot profile yet. Ask your club admin for an
              invitation code, then enter it here.
            </div>
            <RedeemInvite onDone={() => window.location.reload()} />
          </div>
        )}

        {!(isPilot && !loading && !me) && (
        <div style={{ display: 'flex', gap: 0, marginBottom: 20, border: '1px solid rgba(10,14,30,0.12)', borderRadius: 8, overflow: 'hidden', width: 'fit-content' }}>
          {TABS.map((t, i) => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              background: activeTab === t.key ? 'rgba(10,14,30,0.07)' : 'transparent',
              border: 'none',
              borderRight: i < TABS.length - 1 ? '1px solid rgba(10,14,30,0.10)' : 'none',
              color: activeTab === t.key ? '#0a0e1e' : 'rgba(10,14,30,0.5)',
              fontFamily: 'monospace', fontSize: 12, padding: '10px 18px', cursor: 'pointer',
              letterSpacing: 0.5, transition: 'all 0.15s', whiteSpace: 'nowrap',
            }}>
              {t.label}
            </button>
          ))}
        </div>
        )}

        {loading ? (
          <div style={{ color: 'rgba(10,14,30,0.35)', textAlign: 'center', paddingTop: 80, fontSize: 13 }}>
            Loading logbook…
          </div>
        ) : (
          <>
            {activeTab === 'mine' && me && (
              <MyFlights me={me} flights={myFlights} pilots={pilots} acLabel={acLabel} onReplay={handleReplay} />
            )}
            {!isPilot && activeTab === 'pilots' && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <SortBar value={sortPilots} onChange={setSortPilots} options={PILOT_SORTS} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {sortedPilots.length === 0 && <div style={{ color: 'rgba(10,14,30,0.35)', textAlign: 'center', paddingTop: 48 }}>No pilots in this club</div>}
                  {sortedPilots.map(p => <PilotCard key={p.id} pilot={p} flights={flights} pilots={pilots} mode="pilot" acLabel={acLabel} onReplay={handleReplay} onAssign={handleAssign} />)}
                </div>
              </div>
            )}
            {!isPilot && activeTab === 'instructors' && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <SortBar value={sortInstructors} onChange={setSortInstructors} options={PILOT_SORTS} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {sortedInstructors.length === 0 && <div style={{ color: 'rgba(10,14,30,0.35)', textAlign: 'center', paddingTop: 48 }}>No instructors — check the instructor flag in Admin</div>}
                  {sortedInstructors.map(p => <PilotCard key={p.id} pilot={p} flights={flights} pilots={pilots} mode="instructor" acLabel={acLabel} onReplay={handleReplay} onAssign={handleAssign} />)}
                </div>
              </div>
            )}
            {!isPilot && activeTab === 'aircraft' && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <SortBar value={sortAircraft} onChange={setSortAircraft} options={AIRCRAFT_SORTS} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {sortedAircraft.length === 0 && <div style={{ color: 'rgba(10,14,30,0.35)', textAlign: 'center', paddingTop: 48 }}>No aircraft in this club</div>}
                  {sortedAircraft.map(ac => <AircraftCard key={ac.id} ac={ac} flights={flights} pilots={pilots} onReplay={handleReplay} onAssign={handleAssign} />)}
                </div>
              </div>
            )}
            {!isPilot && activeTab === 'matrix' && (
              <FlightMatrix flights={flights} pilots={pilots} aircraft={aircraft} acLabel={acLabel} onReplay={handleReplay} onAssign={handleAssign} canDelete={canDelete} onDelete={handleDelete} />
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
