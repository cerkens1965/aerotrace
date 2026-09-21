// src/components/logbook/FlightAssignModal.jsx
// Le rôle du vol est auto-dérivé du profil pilote via isStudent() (logbookUtils) :
// licence === 'student' → élève → section instructeur obligatoire
// tout le reste (y compris licence absente) → breveté → SOLO, pas d'instructeur
// (lot 02, 2026-09-21) Présenté en tiroir droit AirKi (<Drawer>) au lieu d'une modale centrée.
// Mêmes props et même logique : LogbookPage l'appelle de la même façon (rendu conditionnel,
// donc état ré-initialisé à chaque vol ouvert).

import { useState, useMemo } from 'react'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from '../../firebase/config'
import { Drawer, Button, Banner, StatusDot, T, labelStyle, monoStyle } from '../ui'
import { formatDateTime, formatDuration, deriveFlightType, isStudent as pilotIsStudent, ownerPilotIdFor, FLIGHT_TYPES } from '../../utils/logbookUtils'

export default function FlightAssignModal({ flight, pilots, aircraft, onSave, onClose }) {
  // callSign = identifiant canonique. Résout un aircraftIdent legacy (ancienne registration
  // type "59DWG") vers le callSign de l'avion ("FJFVB").
  const resolveIdent = (cur) => {
    const a = aircraft.find(x => x.callSign === cur || x.registration === cur)
    return a ? (a.callSign || a.registration) : cur
  }
  // Avion 'owner' → son propriétaire (pilote) = pilote par défaut du vol (règle partagée).
  const ownerFor = (cs) => ownerPilotIdFor(aircraft, cs)
  const initIdent = resolveIdent(flight.aircraftIdent || '')
  const [aircraftIdent, setAircraftIdent] = useState(initIdent)
  const [pilotId,           setPilotId]           = useState(flight.pilotId || ownerFor(initIdent))
  const [instructorId,      setInstructorId]      = useState(flight.instructorId  || '')
  const [instructorOnboard, setInstructorOnboard] = useState(
    flight.instructorOnboard ?? true
  )
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  // Édition d'un vol DÉJÀ validé (réattribution) vs première assignation.
  const isEdit = !!flight.validated

  // Statut de vol = champ licence du profil (pas le rôle plateforme), règle unique
  // isStudent() de logbookUtils : 'student' → élève (instructeur requis), sinon breveté.
  const selectedPilot = useMemo(() => pilots.find(p => p.id === pilotId), [pilots, pilotId])
  // VOL PROPRIÉTAIRE : avion owner piloté par son propriétaire → pilot, solo, sans
  // instructeur, quelle que soit la licence du profil. Si un autre pilote est choisi à
  // la main (cas rare), la règle normale isStudent() s'applique.
  const ownerId       = ownerFor(aircraftIdent)
  const isOwnerFlight = !!ownerId && pilotId === ownerId
  const isStudent     = !isOwnerFlight && pilotIsStudent(selectedPilot)
  const isLicensed    = !isStudent
  const pilotRole     = isStudent ? 'student' : 'pilot'

  // Instructeurs = pilots avec isInstructor=true
  const instructors = pilots.filter(p => p.isInstructor === true)

  const flightType = deriveFlightType(
    pilotRole,
    isStudent ? instructorId : null,
    isStudent ? instructorOnboard : null
  )
  const ft = flightType ? FLIGHT_TYPES[flightType] : null

  const canSave = aircraftIdent && pilotId && (!isStudent || instructorId)

  const handleSave = async () => {
    if (!canSave || saving) return
    setSaving(true)
    setError('')
    try {
      const updates = {
        aircraftIdent,
        pilotId,
        pilotRole,
        instructorId:      isStudent ? instructorId      : null,
        instructorOnboard: isStudent ? instructorOnboard : null,
        flightType,
        validated: true,
      }
      await updateDoc(doc(db, 'flights', flight.id), updates)
      onSave(flight.id, updates)
      onClose()
    } catch (e) {
      setError('Error: ' + e.message)
      setSaving(false)
    }
  }

  const subtitle = [
    formatDateTime(flight.startTs),
    formatDuration(flight.duration),
    flight.maxAlt ? `${Math.round(flight.maxAlt)} ft max` : null,
    flight.maxSpd ? `${Math.round(flight.maxSpd)} kt max` : null,
  ].filter(Boolean).join(' · ')

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant="primary" icon="check" onClick={handleSave} disabled={!canSave || saving}>
        {saving ? 'Saving…' : (isEdit ? 'Save' : 'Validate flight')}
      </Button>
    </>
  )

  return (
    <Drawer closeOnOverlay={false}
      open
      onClose={onClose}
      title={isEdit ? 'Edit flight' : 'Assign flight'}
      subtitle={subtitle}
      footer={footer}
    >
      {/* Fichier source */}
      <Section first>
        <div style={labelStyle(T.etch)}>FILE</div>
        <div style={{ ...monoStyle(13, T.ink), marginTop: 6, wordBreak: 'break-all' }}>
          {flight.fileName || flight.id}
        </div>
      </Section>

      {/* Aircraft */}
      <Section>
        <label htmlFor="assign-aircraft" style={LBL}>AIRCRAFT</label>
        <select id="assign-aircraft" className="ak-focus" value={aircraftIdent} onChange={e => { const cs = e.target.value; setAircraftIdent(cs); const o = ownerFor(cs); if (o) { setPilotId(o); setInstructorId('') } }} style={SEL}>
          <option value="">Select an aircraft…</option>
          {aircraft.map(a => { const cs = a.callSign || a.registration; return (
            <option key={a.id} value={cs}>
              {cs} — {a.typeDesig || a.type}
            </option>
          )})}
        </select>
        {ownerId && (
          <div style={HINT}>Owner aircraft — pilot set to the owner</div>
        )}
      </Section>

      {/* Pilote */}
      <Section>
        <label htmlFor="assign-pilot" style={LBL}>PILOT AT THE CONTROLS</label>
        <select id="assign-pilot" className="ak-focus" value={pilotId} onChange={e => { setPilotId(e.target.value); setInstructorId('') }} style={SEL}>
          <option value="">Select a pilot…</option>
          {pilots.map(p => (
            <option key={p.id} value={p.id}>
              {p.firstName} {p.lastName}
              {p.trigram ? ` (${p.trigram})` : ''}
              {p.licences?.length ? ` — ${p.licences.join('/')}` : ''}
            </option>
          ))}
        </select>

        {/* Statut vol auto — depuis champ licence du profil */}
        {selectedPilot && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <span style={labelStyle(T.etch)}>FLIGHT STATUS</span>
            {isLicensed
              ? <StatusDot tone="ok" text={`PILOT${selectedPilot.isInstructor ? ' · INSTRUCTOR' : ''}`} />
              : <StatusDot tone="info" text="STUDENT — INSTRUCTOR REQUIRED" />}
            <span style={{ marginLeft: 'auto', color: T.etch, fontSize: 12 }}>from profile</span>
          </div>
        )}
      </Section>

      {/* Section instructeur — uniquement si student */}
      {isStudent && pilotId && (
        <Section>
          <label htmlFor="assign-instructor" style={LBL}>INSTRUCTOR</label>
          <select id="assign-instructor" className="ak-focus" value={instructorId} onChange={e => setInstructorId(e.target.value)} style={SEL}>
            <option value="">Select an instructor…</option>
            {instructors.map(p => (
              <option key={p.id} value={p.id}>
                {p.firstName} {p.lastName}{p.trigram ? ` (${p.trigram})` : ''}
              </option>
            ))}
          </select>
          {instructors.length === 0 && (
            <div style={{ marginTop: 8 }}>
              <StatusDot tone="caution" text="No instructor — check roles in Admin" />
            </div>
          )}

          <div style={{ ...LBL, marginTop: 16 }} id="assign-presence">INSTRUCTOR PRESENCE</div>
          <div role="group" aria-labelledby="assign-presence" style={{ display: 'flex', gap: 8 }}>
            <Button
              variant={instructorOnboard === true ? 'primary' : 'secondary'}
              aria-pressed={instructorOnboard === true}
              onClick={() => setInstructorOnboard(true)}
              style={{ flex: 1 }}
            >
              On board
            </Button>
            <Button
              variant={instructorOnboard === false ? 'primary' : 'secondary'}
              aria-pressed={instructorOnboard === false}
              onClick={() => setInstructorOnboard(false)}
              style={{ flex: 1 }}
            >
              On ground
            </Button>
          </div>
        </Section>
      )}

      {/* Type détecté */}
      {ft && (
        <Section>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={labelStyle(T.etch)}>FLIGHT TYPE</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: T.radius.pill, background: ft.color }} />
              <span style={{ fontFamily: T.mono, fontSize: 13, fontWeight: 500, color: T.graphite }}>{ft.short}</span>
            </span>
          </div>
        </Section>
      )}

      {error && <Banner tone="caution" style={{ marginTop: 16 }}>{error}</Banner>}
    </Drawer>
  )
}

// ── Styles & sections (top-level : jamais déclarés dans le composant) ─────────
const LBL  = { ...labelStyle(T.etch), display: 'block', marginBottom: 8 }
const HINT = { color: T.graphite, fontSize: 12, marginTop: 8 }
const SEL  = {
  background: T.card, border: T.border, color: T.ink, fontFamily: T.sans, fontSize: 14,
  height: 38, padding: '0 10px', borderRadius: T.radius.sm, width: '100%', cursor: 'pointer', boxSizing: 'border-box',
}

// Section du tiroir, séparée de la précédente par un filet 1 px.
function Section({ first = false, children }) {
  return (
    <div style={{ padding: first ? '0 0 16px' : '16px 0', borderTop: first ? 'none' : T.border }}>
      {children}
    </div>
  )
}
