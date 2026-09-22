// src/components/logbook/FlightAssignModal.jsx
// Tiroir « Assign flight » (22/09, d'après Claude Design Logbook — export AirKi Dashboard-3).
// Le statut du vol reste AUTO-DÉRIVÉ du profil pilote via isStudent() (logbookUtils) : licence 'student' → élève
// (instructeur obligatoire) ; tout le reste (licence absente comprise) → breveté, SOLO, sans instructeur.
// Vol d'un avion PROPRIÉTAIRE piloté par son propriétaire → breveté, solo, quel que soit le profil.
// Nouveau : résumé du vol (date, durée, alt max, G max, fichier) ; bascules Student / Licensed (lecture du profil)
// et On board / On ground ; « Save & next flight » enchaîne sur le vol suivant de la file (queue) ; suggestion du
// dernier pilote saisi pour le même avion le même jour (suggest).
// Props : flight, pilots, aircraft, onSave(id, updates), onClose(), queue? (vols à attribuer, du plus ancien au plus
// récent), onNext?(flight) (ouvre le suivant), suggest? ({ aircraftIdent, day, pilotId, instructorId, instructorOnboard }).

import { useState, useMemo } from 'react'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from '../../firebase/config'
import { Drawer, Button, Banner, StatusDot, Field, Select, Toggle, T, labelStyle, monoStyle } from '../ui'
import { formatDateTime, formatDuration, deriveFlightType, isStudent as pilotIsStudent, ownerPilotIdFor, FLIGHT_TYPES, tsMillis } from '../../utils/logbookUtils'

const MISSING = '−−−'
const RO = { opacity: 1, cursor: 'default' }   // bascule en lecture seule (statut lu sur le profil) : pleine lisibilité
const dayOf = (ts) => { const t = tsMillis(ts); return t ? new Date(t).toISOString().slice(0, 10) : '' }
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const shortWhen = (ts) => {
  const t = tsMillis(ts); if (!t) return MISSING
  const d = new Date(t)
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function Fact({ label, value, wide }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, gridColumn: wide ? '1 / -1' : undefined, minWidth: 0 }}>
      <span style={labelStyle(T.etch)}>{label}</span>
      <span style={{ ...monoStyle(wide ? 12 : 13, wide ? T.graphite : T.ink), overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  )
}

export default function FlightAssignModal({ flight, pilots, aircraft, onSave, onClose, queue = [], onNext, onOpenLoop, suggest }) {
  // callSign = identifiant canonique. Résout un aircraftIdent legacy (ancienne registration type "59DWG") vers le callSign.
  const resolveIdent = (cur) => {
    const a = aircraft.find(x => x.callSign === cur || x.registration === cur)
    return a ? (a.callSign || a.registration) : cur
  }
  const ownerFor = (cs) => ownerPilotIdFor(aircraft, cs)
  const initIdent = resolveIdent(flight.aircraftIdent || '')
  // Suggestion : même avion, même jour que la dernière attribution de la session → même pilote / instructeur.
  const sug = (!flight.pilotId && suggest && suggest.aircraftIdent === initIdent && suggest.day === dayOf(flight.startTs)) ? suggest : null
  const [aircraftIdent, setAircraftIdent] = useState(initIdent)
  const [pilotId,           setPilotId]           = useState(flight.pilotId || ownerFor(initIdent) || sug?.pilotId || '')
  const [instructorId,      setInstructorId]      = useState(flight.instructorId || sug?.instructorId || '')
  const [instructorOnboard, setInstructorOnboard] = useState(flight.instructorOnboard ?? sug?.instructorOnboard ?? true)
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  const isEdit = !!flight.validated
  const selectedPilot = useMemo(() => pilots.find(p => p.id === pilotId), [pilots, pilotId])
  const ownerId       = ownerFor(aircraftIdent)
  const isOwnerFlight = !!ownerId && pilotId === ownerId
  const isStudent     = !isOwnerFlight && pilotIsStudent(selectedPilot)
  const pilotRole     = isStudent ? 'student' : 'pilot'
  const instructors   = pilots.filter(p => p.isInstructor === true)
  const flightType    = deriveFlightType(pilotRole, isStudent ? instructorId : null, isStudent ? instructorOnboard : null)
  const ft            = flightType ? FLIGHT_TYPES[flightType] : null
  const canSave       = aircraftIdent && pilotId && (!isStudent || instructorId)

  // Position dans la file (vols à attribuer, plus ancien d'abord) → suivant + compteur.
  const idx  = queue.findIndex(f => f.id === flight.id)
  const next = idx >= 0 ? queue[idx + 1] : queue.find(f => f.id !== flight.id)
  const left = Math.max(0, queue.filter(f => f.id !== flight.id).length)

  const save = async (andNext) => {
    if (!canSave || saving) return
    setSaving(true); setError('')
    try {
      const updates = {
        aircraftIdent, pilotId, pilotRole,
        instructorId:      isStudent ? instructorId      : null,
        instructorOnboard: isStudent ? instructorOnboard : null,
        flightType, validated: true,
      }
      await updateDoc(doc(db, 'flights', flight.id), updates)
      onSave(flight.id, updates, { aircraftIdent, day: dayOf(flight.startTs) })
      if (andNext && next && onNext) onNext(next)
      else onClose()
    } catch (e) {
      setError('Error: ' + e.message)
      setSaving(false)
    }
  }

  const footer = (
    <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
      <span style={labelStyle(T.etch)}>{!isEdit && queue.length ? `${left} LEFT AFTER THIS ONE` : ''}</span>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
        {!isEdit && next && onNext ? (<>
          <Button size="sm" onClick={() => save(false)} disabled={!canSave || saving}>Save</Button>
          <Button size="sm" variant="primary" icon="check" onClick={() => save(true)} disabled={!canSave || saving}>{saving ? 'Saving…' : 'Save & next flight'}</Button>
        </>) : (
          <Button size="sm" variant="primary" icon="check" onClick={() => save(false)} disabled={!canSave || saving}>{saving ? 'Saving…' : (isEdit ? 'Save' : 'Validate flight')}</Button>
        )}
      </div>
    </div>
  )

  const acOptions = aircraft.map(a => { const cs = a.callSign || a.registration; return { value: cs, label: `${cs} · ${a.typeDesig || a.type || '−'}` } })
  const pilotOptions = pilots.map(p => ({ value: p.id, label: `${p.firstName || ''} ${p.lastName || ''}`.trim() + (pilotIsStudent(p) ? ' · student' : ' · licensed') }))
  const instrOptions = instructors.map(p => ({ value: p.id, label: `${p.firstName || ''} ${p.lastName || ''}`.trim() + ' · FI' }))

  return (
    <Drawer closeOnOverlay={false} open onClose={onClose}
      title={`${isEdit ? 'Edit flight' : 'Assign flight'}${aircraftIdent ? ` · ${aircraftIdent}` : ''}`}
      subtitle={[formatDateTime(flight.startTs), formatDuration(flight.duration), !isEdit && queue.length ? `${queue.length} in queue` : null].filter(Boolean).join(' · ')}
      footer={footer}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ border: T.border, borderRadius: T.radius.md, padding: '12px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, background: '#FBFAF7' }}>
          <Fact label="DATE" value={formatDateTime(flight.startTs)} />
          <Fact label="DURATION" value={formatDuration(flight.duration)} />
          <Fact label="MAX ALT FT" value={flight.maxAlt ? String(Math.round(flight.maxAlt)) : MISSING} />
          <Fact label="MAX G" value={flight.maxG ? flight.maxG.toFixed(1) : MISSING} />
          <Fact label="FILE" value={flight.fileName || flight.id} wide />
        </div>

        <Field label="AIRCRAFT" hint={ownerId ? 'Owner aircraft: pilot set to the owner.' : undefined}>
          <Select id="assign-aircraft" mono value={aircraftIdent} placeholder="Choose an aircraft…" options={acOptions}
            onChange={cs => { setAircraftIdent(cs); const o = ownerFor(cs); if (o) { setPilotId(o); setInstructorId('') } }} />
        </Field>

        <Field label="PILOT AT THE CONTROLS" hint={sug && pilotId === sug.pilotId ? 'Suggested: same aircraft and day as the flight you just assigned.' : undefined}>
          <Select id="assign-pilot" value={pilotId} placeholder="Choose a pilot…" options={pilotOptions}
            onChange={v => { setPilotId(v); setInstructorId('') }} />
        </Field>

        {selectedPilot && (
          <Field label="FLIGHT STATUS" hint={isOwnerFlight ? 'Owner flying their own aircraft: licensed.' : "From the pilot's profile."}>
            <div style={{ display: 'flex', gap: 6 }}>
              <Toggle active={isStudent} disabled style={RO}>Student</Toggle>
              <Toggle active={!isStudent} disabled style={RO}>Licensed{selectedPilot.isInstructor ? ' · FI' : ''}</Toggle>
            </div>
          </Field>
        )}

        {isStudent && pilotId && (<>
          <Field label="INSTRUCTOR">
            <Select id="assign-instructor" value={instructorId} placeholder="Choose an instructor…" options={instrOptions} onChange={setInstructorId} />
          </Field>
          {instructors.length === 0 && <StatusDot tone="caution" text="NO INSTRUCTOR · CHECK ROLES IN ADMIN" />}
          <Field label="INSTRUCTOR PRESENCE">
            <div role="group" style={{ display: 'flex', gap: 6 }}>
              <Toggle active={instructorOnboard === true} onClick={() => setInstructorOnboard(true)}>On board</Toggle>
              <Toggle active={instructorOnboard === false} onClick={() => setInstructorOnboard(false)}>On ground</Toggle>
            </div>
          </Field>
        </>)}

        {ft && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={labelStyle(T.etch)}>FLIGHT TYPE</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: T.radius.pill, background: ft.color }} />
              <span style={{ fontFamily: T.sans, fontSize: 13, color: T.ink }}>{ft.label}</span>
            </span>
          </div>
        )}

        {error && <Banner tone="caution">{error}</Banner>}

        {!isEdit && (next || onOpenLoop) && (
          <div style={{ borderTop: '1px solid #EDE9E2', paddingTop: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <span style={labelStyle(T.etch)}>{next ? `NEXT IN QUEUE · ${resolveIdent(next.aircraftIdent || '') || MISSING} · ${shortWhen(next.startTs)}` : ''}</span>
            {onOpenLoop && <Button size="sm" variant="ghost" icon="play" onClick={() => onOpenLoop(flight.id)}>Open Loop</Button>}
          </div>
        )}
      </div>
    </Drawer>
  )
}
