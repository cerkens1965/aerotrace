// src/components/logbook/BulkAssignDrawer.jsx
// Attribution GROUPÉE (22/09, demande Christophe « je devrais pouvoir faire de la multisélection pour l'attribution »).
// Un pilote (+ instructeur et présence si élève) pour tous les vols cochés. Chaque vol GARDE son avion ; un vol sans
// avion connu prend celui choisi ici (champ alors obligatoire). Règles appliquées VOL PAR VOL, comme la fiche unitaire :
//   - avion PROPRIÉTAIRE piloté par son propriétaire → breveté, solo, sans instructeur ;
//   - sinon isStudent(profil) : élève → instructeur obligatoire (type Dual / Supervised solo), breveté → Solo.
// Écriture en un seul lot Firestore (writeBatch, ≤ 500 vols) : tout ou rien.
import { useMemo, useState } from 'react'
import { doc, writeBatch } from 'firebase/firestore'
import { db } from '../../firebase/config'
import { Drawer, Button, Banner, StatusDot, Field, Select, Toggle, T, labelStyle, monoStyle } from '../ui'
import { formatDuration, deriveFlightType, isStudent as pilotIsStudent, ownerPilotIdFor, sumDuration, tsMillis, FLIGHT_TYPES } from '../../utils/logbookUtils'

const RO = { opacity: 1, cursor: 'default' }

export default function BulkAssignDrawer({ flights, pilots, aircraft, onDone, onClose }) {
  const resolveIdent = (cur) => {
    const a = aircraft.find(x => x.callSign === cur || x.registration === cur)
    return a ? (a.callSign || a.registration) : (cur || '')
  }
  const idents = flights.map(f => resolveIdent(f.aircraftIdent))
  const missingAc = idents.filter(i => !i).length
  const distinctAc = [...new Set(idents.filter(Boolean))]

  const [fallbackAc, setFallbackAc] = useState('')
  const [pilotId, setPilotId] = useState('')
  const [instructorId, setInstructorId] = useState('')
  const [instructorOnboard, setInstructorOnboard] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const pilot = useMemo(() => pilots.find(p => p.id === pilotId), [pilots, pilotId])
  const instructors = pilots.filter(p => p.isInstructor === true)

  // Plan vol par vol (même logique que la fiche unitaire).
  const plan = flights.map((f, i) => {
    const ident = idents[i] || fallbackAc
    const isOwnerFlight = !!pilotId && ownerPilotIdFor(aircraft, ident) === pilotId
    const student = !isOwnerFlight && pilotIsStudent(pilot)
    const role = student ? 'student' : 'pilot'
    return {
      id: f.id, ident, student,
      updates: {
        aircraftIdent: ident, pilotId, pilotRole: role,
        instructorId: student ? instructorId : null,
        instructorOnboard: student ? instructorOnboard : null,
        flightType: deriveFlightType(role, student ? instructorId : null, student ? instructorOnboard : null),
        validated: true,
      },
    }
  })
  const anyStudent = plan.some(p => p.student)
  const ownerExceptions = pilot && pilotIsStudent(pilot) ? plan.filter(p => !p.student).length : 0
  const canSave = pilotId && (!missingAc || fallbackAc) && (!anyStudent || instructorId) && flights.length > 0
  const types = [...new Set(plan.map(p => p.updates.flightType).filter(Boolean))].map(t => FLIGHT_TYPES[t]?.label || t)

  const save = async () => {
    if (!canSave || saving) return
    setSaving(true); setError('')
    try {
      const batch = writeBatch(db)
      plan.forEach(p => batch.update(doc(db, 'flights', p.id), p.updates))
      await batch.commit()
      onDone(plan.length)
      onClose()
    } catch (e) {
      setError('Nothing was saved: ' + e.message)
      setSaving(false)
    }
  }

  const first = flights.reduce((a, f) => (!a || tsMillis(f.startTs) < tsMillis(a.startTs) ? f : a), null)
  const last  = flights.reduce((a, f) => (!a || tsMillis(f.startTs) > tsMillis(a.startTs) ? f : a), null)
  const span = (f) => { const t = tsMillis(f?.startTs); return t ? new Date(t).toISOString().slice(0, 10) : '−−−' }

  return (
    <Drawer closeOnOverlay={false} open onClose={onClose}
      title={`Assign ${flights.length} flight${flights.length === 1 ? '' : 's'}`}
      subtitle={`${formatDuration(sumDuration(flights))} in total · ${distinctAc.length || '−'} aircraft`}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
          <span style={labelStyle(T.etch)}>ONE SAVE FOR ALL · ALL OR NOTHING</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button size="sm" variant="primary" icon="check" onClick={save} disabled={!canSave || saving}>
              {saving ? 'Saving…' : `Validate ${flights.length} flight${flights.length === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      }>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ border: T.border, borderRadius: T.radius.md, padding: '12px 14px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, background: '#FBFAF7' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}><span style={labelStyle(T.etch)}>FLIGHTS</span><span style={monoStyle(13)}>{flights.length}</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}><span style={labelStyle(T.etch)}>TOTAL</span><span style={monoStyle(13)}>{formatDuration(sumDuration(flights))}</span></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, gridColumn: '1 / -1' }}>
            <span style={labelStyle(T.etch)}>AIRCRAFT</span>
            <span style={{ ...monoStyle(12, T.graphite), overflowWrap: 'anywhere' }}>{distinctAc.join(' · ') || '−−−'}{missingAc ? ` · ${missingAc} without aircraft` : ''}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, gridColumn: '1 / -1' }}>
            <span style={labelStyle(T.etch)}>DATES</span>
            <span style={monoStyle(12, T.graphite)}>{span(first) === span(last) ? span(first) : `${span(first)} → ${span(last)}`}</span>
          </div>
        </div>

        {missingAc > 0 && (
          <Field label="AIRCRAFT FOR FLIGHTS WITHOUT ONE" hint={`${missingAc} selected flight${missingAc === 1 ? ' has' : 's have'} no aircraft. The others keep their own.`}>
            <Select mono value={fallbackAc} placeholder="Choose an aircraft…" onChange={setFallbackAc}
              options={aircraft.map(a => { const cs = a.callSign || a.registration; return { value: cs, label: `${cs} · ${a.typeDesig || a.type || '−'}` } })} />
          </Field>
        )}

        <Field label="PILOT AT THE CONTROLS" hint="Applied to every selected flight.">
          <Select value={pilotId} placeholder="Choose a pilot…" onChange={v => { setPilotId(v); setInstructorId('') }}
            options={pilots.map(p => ({ value: p.id, label: `${p.firstName || ''} ${p.lastName || ''}`.trim() + (pilotIsStudent(p) ? ' · student' : ' · licensed') }))} />
        </Field>

        {pilot && (
          <Field label="FLIGHT STATUS" hint={ownerExceptions ? `${ownerExceptions} flight${ownerExceptions === 1 ? ' is' : 's are'} on this pilot's own aircraft: licensed, solo.` : "From the pilot's profile."}>
            <div style={{ display: 'flex', gap: 6 }}>
              <Toggle active={pilotIsStudent(pilot)} disabled style={RO}>Student</Toggle>
              <Toggle active={!pilotIsStudent(pilot)} disabled style={RO}>Licensed{pilot.isInstructor ? ' · FI' : ''}</Toggle>
            </div>
          </Field>
        )}

        {anyStudent && (<>
          <Field label="INSTRUCTOR">
            <Select value={instructorId} placeholder="Choose an instructor…" onChange={setInstructorId}
              options={instructors.map(p => ({ value: p.id, label: `${p.firstName || ''} ${p.lastName || ''}`.trim() + ' · FI' }))} />
          </Field>
          {instructors.length === 0 && <StatusDot tone="caution" text="NO INSTRUCTOR · CHECK ROLES IN ADMIN" />}
          <Field label="INSTRUCTOR PRESENCE" hint="Same for every selected flight. Open one flight on its own to set it differently.">
            <div role="group" style={{ display: 'flex', gap: 6 }}>
              <Toggle active={instructorOnboard === true} onClick={() => setInstructorOnboard(true)}>On board</Toggle>
              <Toggle active={instructorOnboard === false} onClick={() => setInstructorOnboard(false)}>On ground</Toggle>
            </div>
          </Field>
        </>)}

        {pilot && types.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={labelStyle(T.etch)}>FLIGHT TYPE</span>
            <span style={{ marginLeft: 'auto', fontFamily: T.sans, fontSize: 13, color: T.ink }}>{types.join(' · ')}</span>
          </div>
        )}

        {error && <Banner tone="caution">{error}</Banner>}
      </div>
    </Drawer>
  )
}
