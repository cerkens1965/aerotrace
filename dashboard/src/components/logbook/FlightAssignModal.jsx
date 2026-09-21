// src/components/logbook/FlightAssignModal.jsx
// Le rôle du vol est auto-dérivé du profil pilote via isStudent() (logbookUtils) :
// licence === 'student' → élève → section instructeur obligatoire
// tout le reste (y compris licence absente) → breveté → SOLO, pas d'instructeur

import { useState, useMemo } from 'react'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from '../../firebase/config'
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

  // ── Styles ───────────────────────────────────────────────────
  const lbl = { display: 'block', color: 'rgba(10,14,30,0.45)', fontSize: 10, letterSpacing: 1.5, marginBottom: 7 }
  const sel = {
    background: 'rgba(10,14,30,0.04)', border: '1px solid rgba(10,14,30,0.13)',
    color: '#0a0e1e', fontFamily: 'monospace', fontSize: 13,
    padding: '9px 12px', borderRadius: 6, width: '100%',
    outline: 'none', cursor: 'pointer', boxSizing: 'border-box',
  }
  const RadioBtn = ({ label, active, onClick }) => (
    <button onClick={onClick} type="button" style={{
      flex: 1, padding: '7px 0',
      background: active ? 'rgba(10,14,30,0.08)' : 'rgba(10,14,30,0.03)',
      border: `1px solid ${active ? 'rgba(10,14,30,0.3)' : 'rgba(10,14,30,0.1)'}`,
      color: active ? '#0a0e1e' : 'rgba(10,14,30,0.4)',
      fontFamily: 'monospace', fontSize: 11, fontWeight: active ? 700 : 400,
      borderRadius: 6, cursor: 'pointer', transition: 'all 0.15s',
    }}>{label}</button>
  )

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9000,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'monospace', backdropFilter: 'blur(4px)',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: '#ffffff',
        border: '1px solid rgba(10,14,30,0.12)',
        borderRadius: 12, padding: '28px 32px',
        width: 520, maxWidth: '92vw', maxHeight: '88vh',
        overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.15)',
      }}>

        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ color: 'rgba(10,14,30,0.4)', fontSize: 10, letterSpacing: 2, marginBottom: 6 }}>
            {isEdit ? 'Edit flight' : 'Assign flight'}
          </div>
          <div style={{ color: '#0a0e1e', fontSize: 15, fontWeight: 700 }}>
            {flight.fileName || flight.id}
          </div>
          <div style={{ color: 'rgba(10,14,30,0.5)', fontSize: 12, marginTop: 4 }}>
            {formatDateTime(flight.startTs)} · {formatDuration(flight.duration)}
            {flight.maxAlt ? ` · ${Math.round(flight.maxAlt)} ft max` : ''}
            {flight.maxSpd ? ` · ${Math.round(flight.maxSpd * 1.852)} km/h max` : ''}
          </div>
        </div>

        {/* Aircraft */}
        <div style={{ marginBottom: 18 }}>
          <label style={lbl}>AIRCRAFT</label>
          <select value={aircraftIdent} onChange={e => { const cs = e.target.value; setAircraftIdent(cs); const o = ownerFor(cs); if (o) { setPilotId(o); setInstructorId('') } }} style={sel}>
            <option value="">Select an aircraft…</option>
            {aircraft.map(a => { const cs = a.callSign || a.registration; return (
              <option key={a.id} value={cs}>
                {cs} — {a.typeDesig || a.type}
              </option>
            )})}
          </select>
          {ownerId && (
            <div style={{ color: 'rgba(10,14,30,0.55)', fontSize: 11, marginTop: 6 }}>
              Owner aircraft — pilot set to the owner
            </div>
          )}
        </div>

        {/* Pilote */}
        <div style={{ marginBottom: 18 }}>
          <label style={lbl}>PILOT AT THE CONTROLS</label>
          <select value={pilotId} onChange={e => { setPilotId(e.target.value); setInstructorId('') }} style={sel}>
            <option value="">Select a pilot…</option>
            {pilots.map(p => (
              <option key={p.id} value={p.id}>
                {p.firstName} {p.lastName}
                {p.trigram ? ` (${p.trigram})` : ''}
                {p.licences?.length ? ` — ${p.licences.join('/')}` : ''}
              </option>
            ))}
          </select>
        </div>

        {/* Statut vol auto — depuis champ licence du profil */}
        {selectedPilot && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'rgba(10,14,30,0.03)', border: '1px solid rgba(10,14,30,0.08)',
            borderRadius: 8, padding: '10px 14px', marginBottom: 18,
          }}>
            <span style={{ color: 'rgba(10,14,30,0.4)', fontSize: 10, letterSpacing: 1.5 }}>FLIGHT STATUS</span>
            {isLicensed ? (
              <span style={{ color: '#22c55e', fontFamily: 'monospace', fontSize: 13, fontWeight: 700 }}>
                ✈ PILOT{selectedPilot.isInstructor ? ' · INSTRUCTOR' : ''}
              </span>
            ) : (
              <span style={{ color: '#60a5fa', fontFamily: 'monospace', fontSize: 13, fontWeight: 700 }}>
                🎓 STUDENT — instructor required
              </span>
            )}
            <span style={{ marginLeft: 'auto', color: 'rgba(10,14,30,0.3)', fontSize: 10 }}>from profile</span>
          </div>
        )}

        {/* Section instructeur — uniquement si student */}
        {isStudent && pilotId && (
          <div style={{
            background: 'rgba(96,165,250,0.04)',
            border: '1px solid rgba(96,165,250,0.2)',
            borderRadius: 8, padding: '16px', marginBottom: 18,
          }}>
            <div style={{ marginBottom: 14 }}>
              <label style={lbl}>INSTRUCTOR</label>
              <select value={instructorId} onChange={e => setInstructorId(e.target.value)} style={sel}>
                <option value="">Select an instructor…</option>
                {instructors.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.firstName} {p.lastName}{p.trigram ? ` (${p.trigram})` : ''}
                  </option>
                ))}
              </select>
              {instructors.length === 0 && (
                <div style={{ color: '#F5A623', fontSize: 11, marginTop: 6 }}>
                  No instructor — check roles in Admin
                </div>
              )}
            </div>
            <label style={{ ...lbl, marginBottom: 8 }}>INSTRUCTOR PRESENCE</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <RadioBtn label="🪑 ON BOARD"  active={instructorOnboard === true}  onClick={() => setInstructorOnboard(true)} />
              <RadioBtn label="📡 ON GROUND"  active={instructorOnboard === false} onClick={() => setInstructorOnboard(false)} />
            </div>
          </div>
        )}

        {/* Type détecté */}
        {ft && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'rgba(10,14,30,0.03)', border: '1px solid rgba(10,14,30,0.08)',
            borderRadius: 6, padding: '10px 14px', marginBottom: 22,
          }}>
            <span style={{ color: 'rgba(10,14,30,0.4)', fontSize: 10, letterSpacing: 1.5 }}>FLIGHT TYPE</span>
            <span style={{ color: ft.color, fontFamily: 'monospace', fontSize: 13, fontWeight: 700 }}>
              {ft.label.toUpperCase()}
            </span>
            <span style={{ marginLeft: 'auto', width: 8, height: 8, borderRadius: '50%', background: ft.color }} />
          </div>
        )}

        {error && <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 14 }}>{error}</div>}

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button onClick={onClose} type="button" style={{
            background: 'transparent', border: '1px solid rgba(10,14,30,0.15)',
            color: 'rgba(10,14,30,0.5)', fontFamily: 'monospace',
            fontSize: 12, padding: '8px 18px', borderRadius: 6, cursor: 'pointer',
          }}>
            Cancel
          </button>
          <button onClick={handleSave} disabled={!canSave || saving} type="button" style={{
            background: canSave && !saving ? '#0a0e1e' : 'rgba(10,14,30,0.06)',
            border: `1px solid ${canSave && !saving ? '#0a0e1e' : 'rgba(10,14,30,0.1)'}`,
            color: canSave && !saving ? '#ffffff' : 'rgba(10,14,30,0.25)',
            fontFamily: 'monospace', fontSize: 12, fontWeight: 700,
            padding: '8px 22px', borderRadius: 6,
            cursor: canSave && !saving ? 'pointer' : 'not-allowed',
            letterSpacing: 0.5, transition: 'all 0.15s',
          }}>
            {saving ? '…' : (isEdit ? '✓ Save' : '✓ Validate flight')}
          </button>
        </div>
      </div>
    </div>
  )
}
