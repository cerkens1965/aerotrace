// src/pages/LogbookPage.jsx
// Carnet de route relationnel — 4 onglets
//   PILOTES      → logbook par pilote/étudiant (heures, vols, instructeurs)
//   INSTRUCTEURS → logbook par instructeur (heures instruites, élèves, présence)
//   AVIONS       → logbook par aéronef (heures, pilotes, utilisation)
//   TOUS LES VOLS→ matrice admin filtrable (Qui-Quoi-Comment), assignation inline

import { useState, useEffect, useCallback, useMemo } from 'react'
import { collection, getDocs } from 'firebase/firestore'
import { db } from '../firebase/config'
import { useNavigate } from 'react-router-dom'
import FlightAssignModal from '../components/logbook/FlightAssignModal'
import {
  formatDate, formatDuration, sortByDateDesc,
  FLIGHT_TYPES, getPilotName, sumDuration, flightTypeBadge,
} from '../utils/logbookUtils'

const CLUB_ID = 'club_aerobelgique'

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
      {validated ? '✓ OK' : '⚠ À ASSIGNER'}
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
const CARD_STYLE = { background: '#ffffff', borderRadius: 8, overflow: 'hidden' }

// ─── PilotCard ────────────────────────────────────────────────────────────────

function PilotCard({ pilot, flights, pilots, mode, onReplay, onAssign }) {
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

  const unvalidated = myFlights.filter(f => !f.validated).length

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
                {unvalidated} non assigné{unvalidated > 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 5, marginTop: 5, flexWrap: 'wrap', alignItems: 'center' }}>
            {(pilot.licences || []).map(lic => (
              <span key={lic} style={{ background: 'rgba(10,14,30,0.06)', border: '1px solid rgba(10,14,30,0.15)', color: '#0a0e1e', fontSize: 10, fontFamily: 'monospace', padding: '1px 6px', borderRadius: 3 }}>{lic}</span>
            ))}
            {counterparts.length > 0 && (
              <span style={{ color: 'rgba(10,14,30,0.45)', fontSize: 11, fontFamily: 'monospace' }}>
                {mode === 'pilot' ? 'avec :' : 'élèves :'} {counterparts.slice(0, 2).join(', ')}{counterparts.length > 2 ? ` +${counterparts.length - 2}` : ''}
              </span>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: 'rgba(10,14,30,0.45)', fontSize: 10, letterSpacing: 1.5 }}>TOTAL</div>
          <div style={{ color: '#0a0e1e', fontFamily: 'monospace', fontSize: 17, fontWeight: 700, marginTop: 2 }}>{formatDuration(total)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: 'rgba(10,14,30,0.45)', fontSize: 10, letterSpacing: 1.5 }}>VOLS</div>
          <div style={{ color: '#0a0e1e', fontFamily: 'monospace', fontSize: 17, fontWeight: 700, marginTop: 2 }}>{myFlights.length}</div>
          {mode === 'instructor' && myFlights.length > 0 && (
            <div style={{ color: 'rgba(10,14,30,0.50)', fontSize: 10, marginTop: 2 }}>{onboard.length}✈ {fromGround.length}📡</div>
          )}
        </div>
        <div style={{ textAlign: 'right', minWidth: 118 }}>
          <div style={{ color: 'rgba(10,14,30,0.45)', fontSize: 10, letterSpacing: 1.5 }}>DERNIÈRE SORTIE</div>
          <div style={{ color: 'rgba(10,14,30,0.80)', fontFamily: 'monospace', fontSize: 11, marginTop: 2 }}>{last ? formatDate(last.startTs, true) : '—'}</div>
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
                <th style={TH}>AVION</th>
                {mode === 'instructor' && <th style={TH}>ÉLÈVE</th>}
                {mode === 'pilot' && <th style={TH}>INSTRUCTEUR</th>}
                <th style={TH}>DURÉE</th>
                <th style={TH}>TYPE</th>
                {mode === 'instructor' && <th style={TH}>PRÉSENCE</th>}
                <th style={TH}>ALT MAX</th>
                <th style={TH}>G MAX</th>
                <th style={TH}></th>
              </tr>
            </thead>
            <tbody>
              {myFlights.map((f, i) => (
                <tr key={f.id} style={{ borderTop: '1px solid rgba(10,14,30,0.06)', background: i % 2 === 0 ? 'transparent' : 'rgba(10,14,30,0.02)' }}>
                  <td style={{ ...TD, color: 'rgba(10,14,30,0.75)', fontSize: 11 }}>{formatDate(f.startTs)}</td>
                  <td style={{ ...TD, color: '#0a0e1e' }}>{f.aircraftIdent || '—'}</td>
                  {mode === 'instructor' && <td style={TD}>{getPilotName(pilots, f.pilotId)}</td>}
                  {mode === 'pilot' && <td style={{ ...TD, color: 'rgba(10,14,30,0.70)' }}>{f.instructorId ? getPilotName(pilots, f.instructorId) : '—'}</td>}
                  <td style={TD}>{formatDuration(f.duration)}</td>
                  <td style={TD}><TypeBadge type={f.flightType} /></td>
                  {mode === 'instructor' && (
                    <td style={{ ...TD, color: 'rgba(10,14,30,0.65)', fontSize: 11 }}>
                      {f.instructorOnboard ? '🪑 à bord' : '📡 au sol'}
                    </td>
                  )}
                  <td style={{ ...TD, color: 'rgba(10,14,30,0.70)' }}>{f.maxAlt ? `${Math.round(f.maxAlt)} ft` : '—'}</td>
                  <td style={{ ...TD, color: f.maxG > 2.5 ? '#ef4444' : 'rgba(10,14,30,0.70)' }}>{f.maxG ? `${f.maxG.toFixed(1)}G` : '—'}</td>
                  <td style={{ ...TD, textAlign: 'right', paddingRight: 16 }}>
                    {f.validated
                      ? <button onClick={() => onReplay(f.id)} style={REPLAY_BTN}>▶ REPLAY</button>
                      : <button onClick={() => onAssign(f)} style={ASSIGN_BTN}>✏ ASSIGNER</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && myFlights.length === 0 && (
        <div style={{ borderTop: '1px solid rgba(10,14,30,0.07)', padding: '20px', color: 'rgba(10,14,30,0.35)', fontFamily: 'monospace', fontSize: 13, textAlign: 'center' }}>Aucun vol enregistré</div>
      )}
    </div>
  )
}

// ─── AircraftCard ─────────────────────────────────────────────────────────────

function AircraftCard({ ac, flights, pilots, onReplay, onAssign }) {
  const [open, setOpen] = useState(false)

  const acFlights = useMemo(() => sortByDateDesc(flights.filter(f => f.aircraftIdent === ac.registration)), [flights, ac.registration])
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
          <div style={{ color: '#0a0e1e', fontFamily: 'monospace', fontSize: 16, fontWeight: 700 }}>{ac.callSign || ac.registration}</div>
          <div style={{ color: 'rgba(10,14,30,0.5)', fontFamily: 'monospace', fontSize: 11, marginTop: 2 }}>{[ac.registration, ac.typeDesig || ac.type, ac.icao24?.toUpperCase()].filter(Boolean).join(' · ')}</div>
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
          <div style={{ color: 'rgba(10,14,30,0.45)', fontSize: 10, letterSpacing: 1.5 }}>VOLS</div>
          <div style={{ color: '#0a0e1e', fontFamily: 'monospace', fontSize: 17, fontWeight: 600, marginTop: 2 }}>{acFlights.length}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: 'rgba(10,14,30,0.45)', fontSize: 10, letterSpacing: 1.5 }}>PILOTES</div>
          <div style={{ color: '#0a0e1e', fontFamily: 'monospace', fontSize: 17, fontWeight: 600, marginTop: 2 }}>{uniquePilots}</div>
        </div>
        <div style={{ textAlign: 'right', minWidth: 110 }}>
          <div style={{ color: 'rgba(10,14,30,0.45)', fontSize: 10, letterSpacing: 1.5 }}>DERNIÈRE SORTIE</div>
          <div style={{ color: 'rgba(10,14,30,0.80)', fontFamily: 'monospace', fontSize: 11, marginTop: 2 }}>{last ? formatDate(last.startTs, true) : '—'}</div>
          {lastPilot && <div style={{ color: 'rgba(10,14,30,0.55)', fontFamily: 'monospace', fontSize: 11 }}>{lastPilot}</div>}
        </div>
      </div>

      {open && acFlights.length > 0 && (
        <div style={{ borderTop: '1px solid rgba(10,14,30,0.07)', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace' }}>
            <thead><tr>
              <th style={TH}>DATE</th><th style={TH}>PILOTE</th><th style={TH}>INSTRUCTEUR</th>
              <th style={TH}>DURÉE</th><th style={TH}>TYPE</th><th style={TH}>ALT MAX</th><th style={TH}>G MAX</th><th style={TH}></th>
            </tr></thead>
            <tbody>
              {acFlights.map((f, i) => (
                <tr key={f.id} style={{ borderTop: '1px solid rgba(10,14,30,0.06)', background: i % 2 === 0 ? 'transparent' : 'rgba(10,14,30,0.02)' }}>
                  <td style={{ ...TD, color: 'rgba(10,14,30,0.75)', fontSize: 11 }}>{formatDate(f.startTs)}</td>
                  <td style={TD}>{getPilotName(pilots, f.pilotId)}</td>
                  <td style={{ ...TD, color: 'rgba(10,14,30,0.65)' }}>
                    {f.instructorId ? `${getPilotName(pilots, f.instructorId)} ${f.instructorOnboard ? '🪑' : '📡'}` : '—'}
                  </td>
                  <td style={TD}>{formatDuration(f.duration)}</td>
                  <td style={TD}><TypeBadge type={f.flightType} /></td>
                  <td style={{ ...TD, color: 'rgba(10,14,30,0.70)' }}>{f.maxAlt ? `${Math.round(f.maxAlt)} ft` : '—'}</td>
                  <td style={{ ...TD, color: f.maxG > 2.5 ? '#ef4444' : 'rgba(10,14,30,0.70)' }}>{f.maxG ? `${f.maxG.toFixed(1)}G` : '—'}</td>
                  <td style={{ ...TD, textAlign: 'right', paddingRight: 16 }}>
                    {f.validated ? <button onClick={() => onReplay(f.id)} style={REPLAY_BTN}>▶ REPLAY</button> : <button onClick={() => onAssign(f)} style={ASSIGN_BTN}>✏ ASSIGNER</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && acFlights.length === 0 && (
        <div style={{ borderTop: '1px solid rgba(10,14,30,0.07)', padding: '20px', color: 'rgba(10,14,30,0.35)', fontFamily: 'monospace', fontSize: 13, textAlign: 'center' }}>Aucun vol pour cet aéronef</div>
      )}
    </div>
  )
}

// ─── FlightMatrix ─────────────────────────────────────────────────────────────

function FlightMatrix({ flights, pilots, aircraft, onReplay, onAssign }) {
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
    if (filterAircraft) list = list.filter(f => f.aircraftIdent === filterAircraft)
    if (filterType)     list = list.filter(f => f.flightType === filterType)
    if (filterStatus === 'validated') list = list.filter(f =>  f.validated)
    if (filterStatus === 'pending')   list = list.filter(f => !f.validated)
    list.sort((a, b) => {
      let va, vb
      if (sortKey === 'date')     { va = a.startTs?.toDate?.() || 0; vb = b.startTs?.toDate?.() || 0 }
      if (sortKey === 'duration') { va = a.duration || 0; vb = b.duration || 0 }
      if (sortKey === 'aircraft') { va = a.aircraftIdent || ''; vb = b.aircraftIdent || '' }
      if (va < vb) return sortDir === 'asc' ? -1 : 1
      if (va > vb) return sortDir === 'asc' ?  1 : -1
      return 0
    })
    return list
  }, [flights, filterPilot, filterInstr, filterAircraft, filterType, filterStatus, sortKey, sortDir])

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

  const pendingCount = flights.filter(f => !f.validated).length

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 14, alignItems: 'center' }}>
        <select value={filterPilot} onChange={e => setFilterPilot(e.target.value)} style={selectStyle}>
          <option value="">Tous les pilotes</option>
          {pilots.map(p => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
        </select>
        <select value={filterInstr} onChange={e => setFilterInstr(e.target.value)} style={selectStyle}>
          <option value="">Tous les instructeurs</option>
          {instructors.map(p => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
        </select>
        <select value={filterAircraft} onChange={e => setFilterAircraft(e.target.value)} style={selectStyle}>
          <option value="">Tous les avions</option>
          {aircraft.map(a => <option key={a.id} value={a.registration}>{a.registration} — {a.type}</option>)}
        </select>
        <select value={filterType} onChange={e => setFilterType(e.target.value)} style={selectStyle}>
          <option value="">Tous types</option>
          {Object.entries(FLIGHT_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={selectStyle}>
          <option value="">Tous statuts</option>
          <option value="validated">Validés</option>
          <option value="pending">À assigner ({pendingCount})</option>
        </select>
        <span style={{ color: 'rgba(10,14,30,0.45)', fontFamily: 'monospace', fontSize: 12, marginLeft: 'auto' }}>
          {filtered.length} vol{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div style={{ ...CARD_STYLE, border: '1px solid rgba(10,14,30,0.12)', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace' }}>
          <thead style={{ borderBottom: '1px solid rgba(10,14,30,0.10)' }}>
            <tr>
              <SortTH skey="date">DATE</SortTH>
              <SortTH skey="aircraft">AVION</SortTH>
              <th style={TH}>PILOTE</th>
              <th style={TH}>RÔLE</th>
              <th style={TH}>INSTRUCTEUR</th>
              <th style={TH}>PRÉSENCE</th>
              <SortTH skey="duration">DURÉE</SortTH>
              <th style={TH}>TYPE</th>
              <th style={TH}>ALT MAX</th>
              <th style={TH}>STATUT</th>
              <th style={TH}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={11} style={{ ...TD, textAlign: 'center', padding: '32px', color: 'rgba(10,14,30,0.35)' }}>Aucun vol correspondant</td></tr>
            )}
            {filtered.map((f, i) => (
              <tr key={f.id} style={{
                borderTop: '1px solid rgba(10,14,30,0.07)',
                background: !f.validated ? 'rgba(245,166,35,0.02)' : i % 2 === 0 ? 'transparent' : 'rgba(10,14,30,0.02)',
              }}>
                <td style={{ ...TD, color: 'rgba(10,14,30,0.75)', fontSize: 11 }}>{formatDate(f.startTs)}</td>
                <td style={{ ...TD, color: '#0a0e1e' }}>{f.aircraftIdent || '—'}</td>
                <td style={TD}>{getPilotName(pilots, f.pilotId)}</td>
                <td style={TD}>
                  {f.pilotRole === 'student'
                    ? <span style={{ color: '#60a5fa', fontSize: 11 }}>🎓 ÉLÈVE</span>
                    : f.pilotRole === 'pilot'
                    ? <span style={{ color: 'rgba(10,14,30,0.70)', fontSize: 11 }}>✈ PILOTE</span>
                    : <span style={{ color: 'rgba(10,14,30,0.35)', fontSize: 11 }}>—</span>}
                </td>
                <td style={{ ...TD, color: 'rgba(10,14,30,0.70)' }}>{f.instructorId ? getPilotName(pilots, f.instructorId) : '—'}</td>
                <td style={{ ...TD, color: 'rgba(10,14,30,0.60)', fontSize: 11 }}>
                  {f.instructorId ? (f.instructorOnboard ? '🪑 à bord' : '📡 au sol') : '—'}
                </td>
                <td style={TD}>{formatDuration(f.duration)}</td>
                <td style={TD}><TypeBadge type={f.flightType} /></td>
                <td style={{ ...TD, color: 'rgba(10,14,30,0.70)' }}>{f.maxAlt ? `${Math.round(f.maxAlt)} ft` : '—'}</td>
                <td style={TD}><ValidBadge validated={f.validated} /></td>
                <td style={{ ...TD, textAlign: 'right', paddingRight: 16 }}>
                  {f.validated
                    ? <button onClick={() => onReplay(f.id)} style={REPLAY_BTN}>▶ REPLAY</button>
                    : <button onClick={() => onAssign(f)} style={ASSIGN_BTN}>✏ ASSIGNER</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── LogbookPage ──────────────────────────────────────────────────────────────

export default function LogbookPage() {
  const [tab,          setTab]          = useState('pilots')
  const [pilots,       setPilots]       = useState([])
  const [aircraft,     setAircraft]     = useState([])
  const [flights,      setFlights]      = useState([])
  const [loading,      setLoading]      = useState(true)
  const [assignFlight, setAssignFlight] = useState(null)
  const navigate = useNavigate()

  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      setLoadError(null)
      try {
        const [pilotsSnap, aircraftSnap, flightsSnap] = await Promise.all([
          getDocs(collection(db, 'pilots')),
          getDocs(collection(db, 'aircraft')),
          getDocs(collection(db, 'flights')),
        ])
        const p = pilotsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.archived !== true)
        const a = aircraftSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => a.archived !== true)
        const f = flightsSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        console.log('[Logbook] pilots:', p.length, 'aircraft:', a.length, 'flights:', f.length)
        setPilots(p)
        setAircraft(a)
        setFlights(f)
      } catch (e) {
        console.error('Logbook load error:', e)
        setLoadError(e.message)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // ── Sort state ───────────────────────────────────────────────────────────────
  const [sortPilots,   setSortPilots]   = useState('alpha')   // 'alpha' | 'lastFlight' | 'hours'
  const [sortAircraft, setSortAircraft] = useState('alpha')   // 'alpha' | 'lastFlight' | 'hours'

  const handleAssigned = useCallback((flightId, updates) => {
    setFlights(prev => prev.map(f => f.id === flightId ? { ...f, ...updates } : f))
  }, [])

  const handleReplay = useCallback(id => navigate(`/replay/${id}`), [navigate])
  const handleAssign = useCallback(f => setAssignFlight(f), [])

  const totalSeconds  = useMemo(() => flights.reduce((s, f) => s + (f.duration || 0), 0), [flights])
  const pendingCount  = useMemo(() => flights.filter(f => !f.validated).length, [flights])
  const instructors   = useMemo(() => pilots.filter(p => p.isInstructor === true), [pilots])
  const regularPilots = useMemo(() => pilots, [pilots])

  // ── Sorted lists ─────────────────────────────────────────────────────────────
  const sortedPilots = useMemo(() => {
    const withStats = regularPilots.map(p => {
      const pFlights = flights.filter(f => f.pilotId === p.id)
      const last = pFlights.sort((a, b) => (b.startTs?.toDate?.() || 0) - (a.startTs?.toDate?.() || 0))[0]
      return { ...p, _totalSecs: pFlights.reduce((s, f) => s + (f.duration || 0), 0), _lastTs: last?.startTs?.toDate?.() || null }
    })
    if (sortPilots === 'alpha')      return [...withStats].sort((a, b) => a.lastName.localeCompare(b.lastName))
    if (sortPilots === 'lastFlight') return [...withStats].sort((a, b) => (b._lastTs || 0) - (a._lastTs || 0))
    if (sortPilots === 'hours')      return [...withStats].sort((a, b) => b._totalSecs - a._totalSecs)
    return withStats
  }, [regularPilots, flights, sortPilots])

  const sortedInstructors = useMemo(() => {
    const withStats = instructors.map(p => {
      const pFlights = flights.filter(f => f.instructorId === p.id)
      const last = pFlights.sort((a, b) => (b.startTs?.toDate?.() || 0) - (a.startTs?.toDate?.() || 0))[0]
      return { ...p, _totalSecs: pFlights.reduce((s, f) => s + (f.duration || 0), 0), _lastTs: last?.startTs?.toDate?.() || null }
    })
    if (sortPilots === 'alpha')      return [...withStats].sort((a, b) => a.lastName.localeCompare(b.lastName))
    if (sortPilots === 'lastFlight') return [...withStats].sort((a, b) => (b._lastTs || 0) - (a._lastTs || 0))
    if (sortPilots === 'hours')      return [...withStats].sort((a, b) => b._totalSecs - a._totalSecs)
    return withStats
  }, [instructors, flights, sortPilots])

  const sortedAircraft = useMemo(() => {
    const withStats = aircraft.map(ac => {
      const acFlights = flights.filter(f => f.aircraftIdent === ac.registration)
      const last = acFlights.sort((a, b) => (b.startTs?.toDate?.() || 0) - (a.startTs?.toDate?.() || 0))[0]
      return { ...ac, _totalSecs: acFlights.reduce((s, f) => s + (f.duration || 0), 0), _lastTs: last?.startTs?.toDate?.() || null }
    })
    if (sortAircraft === 'alpha')      return [...withStats].sort((a, b) => (a.callSign || a.registration).localeCompare(b.callSign || b.registration))
    if (sortAircraft === 'lastFlight') return [...withStats].sort((a, b) => (b._lastTs || 0) - (a._lastTs || 0))
    if (sortAircraft === 'hours')      return [...withStats].sort((a, b) => b._totalSecs - a._totalSecs)
    return withStats
  }, [aircraft, flights, sortAircraft])

  // ── Sort bar component ────────────────────────────────────────────────────────
  const SortBar = ({ value, onChange, options }) => (
    <div style={{ display: 'flex', gap: 6, marginBottom: 14, alignItems: 'center' }}>
      <span style={{ color: 'rgba(10,14,30,0.4)', fontSize: 10, letterSpacing: 1.2, marginRight: 4 }}>TRIER PAR</span>
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

  const PILOT_SORTS    = [{ key: 'alpha', label: 'A→Z' }, { key: 'lastFlight', label: 'Dernier vol' }, { key: 'hours', label: 'Heures ↓' }]
  const AIRCRAFT_SORTS = [{ key: 'alpha', label: 'A→Z' }, { key: 'lastFlight', label: 'Dernière sortie' }, { key: 'hours', label: 'Heures ↓' }]

  const TABS = [
    { key: 'pilots',      label: `👤 PILOTES (${regularPilots.length})` },
    { key: 'instructors', label: `🎓 INSTRUCTEURS (${instructors.length})` },
    { key: 'aircraft',    label: `✈ AVIONS (${aircraft.length})` },
    { key: 'matrix',      label: pendingCount > 0 ? `⚠ TOUS LES VOLS  ${pendingCount} en attente` : '☰ TOUS LES VOLS' },
  ]

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: '#f0f2f8', fontFamily: 'monospace' }}>
      <div style={{ padding: '80px 32px 48px', maxWidth: 1280, margin: '0 auto' }}>

        <div style={{ marginBottom: 28 }}>
          <div style={{ color: 'rgba(10,14,30,0.5)', fontSize: 10, letterSpacing: 2.5, marginBottom: 6 }}>
            ULM BAISY-THY · EBBY · {new Date().getFullYear()}
          </div>
          <h1 style={{ color: '#0a0e1e', fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: 1 }}>CARNET DE ROUTE</h1>
        </div>

        {loadError && (
          <div style={{
            background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.4)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 20,
            color: '#ef4444', fontFamily: 'monospace', fontSize: 12,
          }}>
            ❌ Erreur chargement Firestore : {loadError}
          </div>
        )}

        {!loading && !loadError && pilots.length === 0 && flights.length === 0 && (
          <div style={{
            background: 'rgba(245,166,35,0.08)', border: '1px solid rgba(245,166,35,0.3)',
            borderRadius: 8, padding: '12px 16px', marginBottom: 20,
            color: '#F5A623', fontFamily: 'monospace', fontSize: 12,
          }}>
            ⚠ Firestore accessible mais collections vides — ouvre la console (F12) pour les logs
          </div>
        )}

        {!loading && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 24 }}>
            <StatCard label="PILOTES"              value={regularPilots.length} />
            <StatCard label="INSTRUCTEURS"        value={instructors.length} />
            <StatCard label="AVIONS"              value={aircraft.length} />
            <StatCard label="VOLS TOTAL"          value={flights.length} />
            <StatCard label="HEURES TOTALES"      value={formatDuration(totalSeconds)} accent />
          </div>
        )}

        <div style={{ display: 'flex', gap: 0, marginBottom: 20, border: '1px solid rgba(10,14,30,0.12)', borderRadius: 8, overflow: 'hidden', width: 'fit-content' }}>
          {TABS.map((t, i) => (
            <button key={t.key} onClick={() => setTab(t.key)} style={{
              background: tab === t.key ? 'rgba(10,14,30,0.07)' : 'transparent',
              border: 'none',
              borderRight: i < TABS.length - 1 ? '1px solid rgba(10,14,30,0.10)' : 'none',
              color: tab === t.key ? '#0a0e1e' : 'rgba(10,14,30,0.5)',
              fontFamily: 'monospace', fontSize: 12, padding: '10px 18px', cursor: 'pointer',
              letterSpacing: 0.5, transition: 'all 0.15s', whiteSpace: 'nowrap',
            }}>
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div style={{ color: 'rgba(10,14,30,0.35)', textAlign: 'center', paddingTop: 80, fontSize: 13 }}>
            Chargement du carnet de route…
          </div>
        ) : (
          <>
            {tab === 'pilots' && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <SortBar value={sortPilots} onChange={setSortPilots} options={PILOT_SORTS} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {sortedPilots.length === 0 && <div style={{ color: 'rgba(10,14,30,0.35)', textAlign: 'center', paddingTop: 48 }}>Aucun pilote dans le club</div>}
                  {sortedPilots.map(p => <PilotCard key={p.id} pilot={p} flights={flights} pilots={pilots} mode="pilot" onReplay={handleReplay} onAssign={handleAssign} />)}
                </div>
              </div>
            )}
            {tab === 'instructors' && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <SortBar value={sortPilots} onChange={setSortPilots} options={PILOT_SORTS} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {sortedInstructors.length === 0 && <div style={{ color: 'rgba(10,14,30,0.35)', textAlign: 'center', paddingTop: 48 }}>Aucun instructeur — vérifier isInstructor dans ADMIN</div>}
                  {sortedInstructors.map(p => <PilotCard key={p.id} pilot={p} flights={flights} pilots={pilots} mode="instructor" onReplay={handleReplay} onAssign={handleAssign} />)}
                </div>
              </div>
            )}
            {tab === 'aircraft' && (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <SortBar value={sortAircraft} onChange={setSortAircraft} options={AIRCRAFT_SORTS} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {sortedAircraft.length === 0 && <div style={{ color: 'rgba(10,14,30,0.35)', textAlign: 'center', paddingTop: 48 }}>Aucun avion dans le club</div>}
                  {sortedAircraft.map(ac => <AircraftCard key={ac.id} ac={ac} flights={flights} pilots={pilots} onReplay={handleReplay} onAssign={handleAssign} />)}
                </div>
              </div>
            )}
            {tab === 'matrix' && (
              <FlightMatrix flights={flights} pilots={pilots} aircraft={aircraft} onReplay={handleReplay} onAssign={handleAssign} />
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
