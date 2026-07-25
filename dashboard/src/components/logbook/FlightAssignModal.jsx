// src/components/logbook/FlightAssignModal.jsx
// Le rôle du vol est auto-dérivé du profil pilote (pilots.role)
// Student → section instructeur obligatoire
// Pilot/Instructor/Admin → SOLO, pas d'instructeur

import { useState, useMemo } from 'react'
import { doc, updateDoc } from 'firebase/firestore'
import { db } from '../../firebase/config'
import { formatDate, formatDuration, deriveFlightType, FLIGHT_TYPES } from '../../utils/logbookUtils'

export default function FlightAssignModal({ flight, pilots, aircraft, onSave, onClose }) {
  // callSign = identifiant canonique. Résout un aircraftIdent legacy (ancienne registration
  // type "59DWG") vers le callSign de l'avion ("FJFVB") pour la pré-sélection.
  const [aircraftIdent, setAircraftIdent] = useState(() => {
    const cur = flight.aircraftIdent || ''
    const a = aircraft.find(x => x.callSign === cur || x.registration === cur)
    return a ? (a.callSign || a.registration) : cur
  })
  const [pilotId,           setPilotId]           = useState(flight.pilotId       || '')
  const [instructorId,      setInstructorId]      = useState(flight.instructorId  || '')
  const [instructorOnboard, setInstructorOnboard] = useState(
    flight.instructorOnboard ?? true
  )
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  // Édition d'un vol DÉJÀ validé (réattribution) vs première assignation.
  const isEdit = !!flight.validated

  // Statut de vol = champ licence du profil (pas le rôle plateforme)
  // licence='pilot' → breveté → SOLO
  // licence='student' ou absent → en formation → instructor requis
  const selectedPilot = useMemo(() => pilots.find(p => p.id === pilotId), [pilots, pilotId])
  const isLicensed    = selectedPilot?.licence === 'pilot'
  const pilotRole     = isLicensed ? 'pilot' : 'student'
  const isStudent     = !isLicensed

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
      setError('Erreur : ' + e.message)
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
            {isEdit ? 'ÉDITER LE VOL' : 'ASSIGNATION VOL'}
          </div>
          <div style={{ color: '#0a0e1e', fontSize: 15, fontWeight: 700 }}>
            {flight.fileName || flight.id}
          </div>
          <div style={{ color: 'rgba(10,14,30,0.5)', fontSize: 12, marginTop: 4 }}>
            {formatDate(flight.startTs)} · {formatDuration(flight.duration)}
            {flight.maxAlt ? ` · ${Math.round(flight.maxAlt)} ft max` : ''}
            {flight.maxSpd ? ` · ${Math.round(flight.maxSpd)} kt max` : ''}
          </div>
        </div>

        {/* Aéronef */}
        <div style={{ marginBottom: 18 }}>
          <label style={lbl}>AÉRONEF</label>
          <select value={aircraftIdent} onChange={e => setAircraftIdent(e.target.value)} style={sel}>
            <option value="">Sélectionner un avion…</option>
            {aircraft.map(a => { const cs = a.callSign || a.registration; return (
              <option key={a.id} value={cs}>
                {cs} — {a.typeDesig || a.type}
              </option>
            )})}
          </select>
        </div>

        {/* Pilote */}
        <div style={{ marginBottom: 18 }}>
          <label style={lbl}>PILOTE AUX COMMANDES</label>
          <select value={pilotId} onChange={e => { setPilotId(e.target.value); setInstructorId('') }} style={sel}>
            <option value="">Sélectionner un pilote…</option>
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
            <span style={{ color: 'rgba(10,14,30,0.4)', fontSize: 10, letterSpacing: 1.5 }}>STATUT VOL</span>
            {isLicensed ? (
              <span style={{ color: '#22c55e', fontFamily: 'monospace', fontSize: 13, fontWeight: 700 }}>
                ✈ PILOT{selectedPilot.isInstructor ? ' · INSTRUCTEUR' : ''}
              </span>
            ) : (
              <span style={{ color: '#60a5fa', fontFamily: 'monospace', fontSize: 13, fontWeight: 700 }}>
                🎓 STUDENT — instructor requis
              </span>
            )}
            <span style={{ marginLeft: 'auto', color: 'rgba(10,14,30,0.3)', fontSize: 10 }}>depuis profil</span>
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
              <label style={lbl}>INSTRUCTEUR</label>
              <select value={instructorId} onChange={e => setInstructorId(e.target.value)} style={sel}>
                <option value="">Sélectionner un instructeur…</option>
                {instructors.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.firstName} {p.lastName}{p.trigram ? ` (${p.trigram})` : ''}
                  </option>
                ))}
              </select>
              {instructors.length === 0 && (
                <div style={{ color: '#F5A623', fontSize: 11, marginTop: 6 }}>
                  Aucun instructeur — vérifier les rôles dans ADMIN
                </div>
              )}
            </div>
            <label style={{ ...lbl, marginBottom: 8 }}>PRÉSENCE INSTRUCTEUR</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <RadioBtn label="🪑 À BORD"  active={instructorOnboard === true}  onClick={() => setInstructorOnboard(true)} />
              <RadioBtn label="📡 AU SOL"  active={instructorOnboard === false} onClick={() => setInstructorOnboard(false)} />
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
            <span style={{ color: 'rgba(10,14,30,0.4)', fontSize: 10, letterSpacing: 1.5 }}>TYPE DE VOL</span>
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
            ANNULER
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
            {saving ? '…' : (isEdit ? '✓ ENREGISTRER' : '✓ VALIDER LE VOL')}
          </button>
        </div>
      </div>
    </div>
  )
}
