import { useState, useEffect, useCallback } from 'react'
import {
  collection, getDocs, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp, query, orderBy,
} from 'firebase/firestore'
import { db } from '../firebase/config'

// ─── Design tokens — WHITE theme ─────────────────────────────────────────────
const C = {
  bg:      '#f4f5f7',
  surface: '#ffffff',
  border:  'rgba(10,14,30,0.10)',
  text:    '#0a0e1e',
  mid:     'rgba(10,14,30,0.55)',
  low:     'rgba(10,14,30,0.30)',
  mono:    'monospace',
  amber:   '#F5A623',
  amber10: 'rgba(245,166,35,0.10)',
  amber20: 'rgba(245,166,35,0.20)',
  green:   '#22c55e',
  green10: 'rgba(34,197,94,0.10)',
  red:     '#ef4444',
  red10:   'rgba(239,68,68,0.10)',
  blue:    '#60a5fa',
  blue10:  'rgba(96,165,250,0.10)',
}

// ─── Constants ────────────────────────────────────────────────────────────────
const ROLES    = ['user', 'instructor', 'admin']
const LICENCES = ['PPL', 'ULM', 'LAPL', 'CPL', 'ATPL', 'IR', 'ME', 'Night']
const TYPE_DESIG = [
  { value: 'PA28',  label: 'PA28  — Piper Cherokee' },
  { value: 'C172',  label: 'C172  — Cessna 172' },
  { value: 'C152',  label: 'C152  — Cessna 152' },
  { value: 'DR400', label: 'DR400 — Robin DR400' },
  { value: 'TB10',  label: 'TB10  — Socata Tobago' },
  { value: 'TB20',  label: 'TB20  — Socata Trinidad' },
  { value: 'DA40',  label: 'DA40  — Diamond DA40' },
  { value: 'DA20',  label: 'DA20  — Diamond DA20' },
  { value: 'SR22',  label: 'SR22  — Cirrus SR22' },
  { value: 'ULM',   label: 'ULM   — Ultraléger motorisé' },
  { value: 'OTHER', label: 'OTHER — Autre' },
]

const EMPTY_PILOT = {
  firstName: '', lastName: '', email: '',
  role: 'user',
  licence: 'student',
  isInstructor: false,
  birthDate: '', licenceDate: '',
  licences: [], trigram: '', pin: '',
}
const EMPTY_AIRCRAFT = {
  registration: '', callSign: '', typeDesig: '', icao24: '', homeBase: '',
}

// ─── Reusable form components ─────────────────────────────────────────────────
const Label = ({ children }) => (
  <div style={{ fontFamily: C.mono, fontSize: 9, letterSpacing: '0.12em', color: C.low, marginBottom: 5 }}>
    {children}
  </div>
)

const Input = ({ value, onChange, placeholder, type = 'text', maxLength }) => (
  <input
    type={type} value={value} onChange={e => onChange(e.target.value)}
    placeholder={placeholder} maxLength={maxLength}
    style={{
      width: '100%', boxSizing: 'border-box',
      background: C.bg, border: `1px solid ${C.border}`,
      color: C.text, fontFamily: C.mono, fontSize: 12,
      padding: '8px 10px', borderRadius: 6, outline: 'none',
    }}
  />
)

const Select = ({ value, onChange, options }) => (
  <select
    value={value} onChange={e => onChange(e.target.value)}
    style={{
      width: '100%', boxSizing: 'border-box',
      background: C.bg, border: `1px solid ${C.border}`,
      color: C.text, fontFamily: C.mono, fontSize: 12,
      padding: '8px 10px', borderRadius: 6, outline: 'none', cursor: 'pointer',
    }}
  >
    {options.map(o => (
      <option key={o.value} value={o.value}>{o.label}</option>
    ))}
  </select>
)

// ─── Trigram generator ────────────────────────────────────────────────────────
function generateTrigram(firstName, lastName, existing = []) {
  const clean = s => s.toUpperCase().replace(/[^A-Z]/g, '')
  const f = clean(firstName)
  const l = clean(lastName)
  const candidates = []
  if (f.length >= 1 && l.length >= 2) candidates.push(f[0] + l[0] + l[1])
  if (f.length >= 2 && l.length >= 1) candidates.push(f[0] + f[1] + l[0])
  if (f.length >= 1 && l.length >= 1) candidates.push(l[0] + l[1] + (l[2] || f[0]))
  const set = new Set(existing.map(s => s.toUpperCase()))
  return candidates.find(c => !set.has(c)) ?? ''
}

// ─── Pilot form panel ─────────────────────────────────────────────────────────
function PilotForm({ form, setForm, allTrigrams, saving, error, onSave, onCancel, isEdit }) {
  const toggleLicence = (lic) => {
    setForm(p => ({
      ...p,
      licences: p.licences.includes(lic) ? p.licences.filter(l => l !== lic) : [...p.licences, lic],
    }))
  }

  const autoTrigram = () => {
    const existing = allTrigrams.filter(t => t !== form.trigram)
    const trig = generateTrigram(form.firstName, form.lastName, existing)
    if (trig) setForm(p => ({ ...p, trigram: trig }))
  }

  const trigramConflict = allTrigrams.filter(t => t !== (isEdit ? form._origTrigram : '')).includes(form.trigram.toUpperCase())

  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`,
      borderRadius: 10, padding: 20,
    }}>
      <div style={{ fontFamily: C.mono, fontSize: 9, letterSpacing: '0.14em', color: C.low, marginBottom: 18 }}>
        {isEdit ? 'EDIT PILOT' : 'NEW PILOT'}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        {/* Name */}
        <div>
          <Label>FIRST NAME</Label>
          <Input value={form.firstName} onChange={v => setForm(p => ({ ...p, firstName: v }))} placeholder="John" />
        </div>
        <div>
          <Label>LAST NAME</Label>
          <Input value={form.lastName} onChange={v => setForm(p => ({ ...p, lastName: v }))} placeholder="Smith" />
        </div>

        {/* Email */}
        <div style={{ gridColumn: '1/-1' }}>
          <Label>EMAIL</Label>
          <Input value={form.email} onChange={v => setForm(p => ({ ...p, email: v }))} placeholder="john@example.com" type="email" />
        </div>

        {/* Platform role */}
        <div>
          <Label>PLATFORM ROLE</Label>
          <Select value={form.role} onChange={v => setForm(p => ({ ...p, role: v }))}
            options={ROLES.map(r => ({ value: r, label: r.toUpperCase() }))} />
          <div style={{ fontFamily: C.mono, fontSize: 8, color: C.low, marginTop: 3 }}>
            Page access & permissions
          </div>
        </div>

        {/* Flying qualification */}
        <div>
          <Label>FLYING QUALIFICATION</Label>
          <div style={{ display: 'flex', gap: 6 }}>
            {['student', 'pilot'].map(lic => {
              const active = form.licence === lic
              return (
                <button key={lic} type="button"
                  onClick={() => setForm(p => ({
                    ...p,
                    licence: lic,
                    isInstructor: lic === 'student' ? false : p.isInstructor,
                  }))}
                  style={{
                    flex: 1, padding: '7px 0', borderRadius: 6, cursor: 'pointer',
                    fontFamily: C.mono, fontSize: 10, fontWeight: 700,
                    background: active ? (lic === 'student' ? C.blue10 : C.green10) : 'transparent',
                    border: `1px solid ${active ? (lic === 'student' ? C.blue : C.green) : C.border}`,
                    color: active ? (lic === 'student' ? C.blue : C.green) : C.mid,
                    transition: 'all 0.15s',
                  }}
                >
                  {lic === 'student' ? '🎓 STUDENT' : '✈ PILOT'}
                </button>
              )
            })}
          </div>
        </div>

        {/* Is instructor — only if pilot */}
        {form.licence === 'pilot' && (
          <div style={{ gridColumn: '1/-1' }}>
            <button type="button"
              onClick={() => setForm(p => ({ ...p, isInstructor: !p.isInstructor }))}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', padding: '10px 14px', borderRadius: 7, cursor: 'pointer',
                background: form.isInstructor ? C.amber10 : C.bg,
                border: `1px solid ${form.isInstructor ? C.amber : C.border}`,
                transition: 'all 0.15s',
              }}
            >
              <div style={{
                width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                background: form.isInstructor ? C.amber : 'transparent',
                border: `2px solid ${form.isInstructor ? C.amber : C.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {form.isInstructor && <span style={{ fontSize: 10, color: '#fff' }}>✓</span>}
              </div>
              <div>
                <div style={{ fontFamily: C.mono, fontSize: 11, fontWeight: 700,
                  color: form.isInstructor ? C.amber : C.mid }}>
                  CERTIFIED INSTRUCTOR (FI)
                </div>
                <div style={{ fontFamily: C.mono, fontSize: 9, color: C.low, marginTop: 2 }}>
                  Can supervise student flights
                </div>
              </div>
            </button>
          </div>
        )}

        {/* Dates */}
        <div>
          <Label>BIRTH DATE</Label>
          <Input type="date" value={form.birthDate} onChange={v => setForm(p => ({ ...p, birthDate: v }))} />
        </div>
        <div>
          <Label>LICENCE DATE</Label>
          <Input type="date" value={form.licenceDate} onChange={v => setForm(p => ({ ...p, licenceDate: v }))} />
        </div>

        {/* Ratings */}
        <div style={{ gridColumn: '1/-1' }}>
          <Label>RATINGS</Label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {LICENCES.map(lic => {
              const on = form.licences.includes(lic)
              return (
                <button key={lic} type="button" onClick={() => toggleLicence(lic)} style={{
                  padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
                  fontFamily: C.mono, fontSize: 9, fontWeight: 700,
                  background: on ? C.amber10 : 'transparent',
                  border: `1px solid ${on ? C.amber : C.border}`,
                  color: on ? C.amber : C.mid, transition: 'all 0.15s',
                }}>{lic}</button>
              )
            })}
          </div>
        </div>

        {/* Trigram */}
        <div>
          <Label>TRIGRAM (3 chars)</Label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={form.trigram}
              onChange={e => setForm(p => ({ ...p, trigram: e.target.value.toUpperCase().slice(0,3) }))}
              maxLength={3}
              style={{
                flex: 1, background: C.bg, border: `1px solid ${trigramConflict ? C.red : C.border}`,
                color: C.text, fontFamily: C.mono, fontSize: 14, fontWeight: 700, letterSpacing: '0.2em',
                padding: '7px 10px', borderRadius: 6, outline: 'none', textAlign: 'center',
              }}
            />
            <button type="button" onClick={autoTrigram} style={{
              padding: '0 12px', borderRadius: 6, cursor: 'pointer',
              background: 'transparent', border: `1px solid ${C.border}`,
              fontFamily: C.mono, fontSize: 9, color: C.mid,
            }}>AUTO</button>
          </div>
          {trigramConflict && (
            <div style={{ fontFamily: C.mono, fontSize: 9, color: C.red, marginTop: 4 }}>
              Trigram already in use
            </div>
          )}
        </div>

        {/* PIN */}
        <div>
          <Label>PIN (4 digits)</Label>
          <input
            type="password" value={form.pin} maxLength={4}
            onChange={e => setForm(p => ({ ...p, pin: e.target.value.replace(/\D/g,'').slice(0,4) }))}
            placeholder="••••"
            style={{
              width: '100%', boxSizing: 'border-box',
              background: C.bg, border: `1px solid ${C.border}`,
              color: C.text, fontFamily: C.mono, fontSize: 18, letterSpacing: '0.4em',
              padding: '7px 10px', borderRadius: 6, outline: 'none', textAlign: 'center',
            }}
          />
          <div style={{ fontFamily: C.mono, fontSize: 8, color: C.low, marginTop: 3 }}>
            Used for FDR identification
          </div>
        </div>
      </div>

      {error && (
        <div style={{ fontFamily: C.mono, fontSize: 10, color: C.red, margin: '12px 0' }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} style={{
          padding: '8px 18px', borderRadius: 6, cursor: 'pointer',
          background: 'transparent', border: `1px solid ${C.border}`,
          fontFamily: C.mono, fontSize: 10, color: C.mid,
        }}>CANCEL</button>
        <button type="button" onClick={onSave} disabled={saving || trigramConflict} style={{
          padding: '8px 22px', borderRadius: 6, cursor: saving ? 'not-allowed' : 'pointer',
          background: saving ? C.bg : C.text, border: `1px solid ${saving ? C.border : C.text}`,
          fontFamily: C.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
          color: saving ? C.mid : '#ffffff', transition: 'all 0.15s',
        }}>{saving ? '…' : isEdit ? '✓ UPDATE' : '✓ CREATE'}</button>
      </div>
    </div>
  )
}

// ─── Aircraft form panel ──────────────────────────────────────────────────────
function AircraftForm({ form, setForm, saving, error, onSave, onCancel, isEdit }) {
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`,
      borderRadius: 10, padding: 20,
    }}>
      <div style={{ fontFamily: C.mono, fontSize: 9, letterSpacing: '0.14em', color: C.low, marginBottom: 18 }}>
        {isEdit ? 'EDIT AIRCRAFT' : 'NEW AIRCRAFT'}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div>
          <Label>REGISTRATION</Label>
          <Input value={form.registration}
            onChange={v => setForm(p => ({ ...p, registration: v.toUpperCase() }))}
            placeholder="OO-VBY" />
        </div>
        <div>
          <Label>CALL SIGN (radio)</Label>
          <Input value={form.callSign}
            onChange={v => setForm(p => ({ ...p, callSign: v.toUpperCase() }))}
            placeholder="VICTOR BRAVO YANKEE" />
        </div>

        <div>
          <Label>TYPE DESIGNATOR (ICAO)</Label>
          <Select
            value={form.typeDesig}
            onChange={v => setForm(p => ({ ...p, typeDesig: v }))}
            options={[{ value: '', label: 'Select type…' }, ...TYPE_DESIG.map(t => ({ value: t.value, label: t.label }))]}
          />
        </div>
        <div>
          <Label>ICAO24 (hex)</Label>
          <Input value={form.icao24}
            onChange={v => setForm(p => ({ ...p, icao24: v.toLowerCase() }))}
            placeholder="4401ab" maxLength={6} />
        </div>

        <div style={{ gridColumn: '1/-1' }}>
          <Label>HOME BASE (ICAO)</Label>
          <Input value={form.homeBase}
            onChange={v => setForm(p => ({ ...p, homeBase: v.toUpperCase() }))}
            placeholder="EBBY" maxLength={4} />
        </div>
      </div>

      {error && (
        <div style={{ fontFamily: C.mono, fontSize: 10, color: C.red, margin: '12px 0' }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onCancel} style={{
          padding: '8px 18px', borderRadius: 6, cursor: 'pointer',
          background: 'transparent', border: `1px solid ${C.border}`,
          fontFamily: C.mono, fontSize: 10, color: C.mid,
        }}>CANCEL</button>
        <button type="button" onClick={onSave} disabled={saving} style={{
          padding: '8px 22px', borderRadius: 6, cursor: saving ? 'not-allowed' : 'pointer',
          background: saving ? C.bg : C.text, border: `1px solid ${saving ? C.border : C.text}`,
          fontFamily: C.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.05em',
          color: saving ? C.mid : '#ffffff', transition: 'all 0.15s',
        }}>{saving ? '…' : isEdit ? '✓ UPDATE' : '✓ CREATE'}</button>
      </div>
    </div>
  )
}

// ─── Row components ───────────────────────────────────────────────────────────
function PilotRow({ pilot, onEdit, onDelete }) {
  const licCol = pilot.licence === 'pilot' ? C.green : C.blue
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 16px', background: C.surface,
      border: `1px solid ${C.border}`, borderRadius: 8,
      transition: 'box-shadow 0.15s',
    }}>
      {/* Avatar */}
      <div style={{
        width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
        background: `${licCol}20`, border: `1px solid ${licCol}44`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: C.mono, fontSize: 11, fontWeight: 700, color: licCol,
      }}>
        {pilot.trigram || `${pilot.firstName?.[0] ?? ''}${pilot.lastName?.[0] ?? ''}`}
      </div>

      {/* Name + details */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 700, color: C.text }}>
          {pilot.firstName} {pilot.lastName}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 3, flexWrap: 'wrap' }}>
          {/* Licence badge */}
          <span style={{
            fontFamily: C.mono, fontSize: 9, fontWeight: 700,
            color: licCol, background: `${licCol}15`,
            padding: '1px 7px', borderRadius: 4,
            border: `1px solid ${licCol}33`,
          }}>
            {pilot.licence?.toUpperCase() ?? 'STUDENT'}
          </span>
          {/* Instructor badge */}
          {pilot.isInstructor && (
            <span style={{
              fontFamily: C.mono, fontSize: 9, fontWeight: 700,
              color: C.amber, background: C.amber10,
              padding: '1px 7px', borderRadius: 4,
              border: `1px solid ${C.amber}44`,
            }}>FI</span>
          )}
          {/* Platform role */}
          <span style={{ fontFamily: C.mono, fontSize: 9, color: C.low }}>
            {pilot.role?.toUpperCase()}
          </span>
          {/* Ratings */}
          {pilot.licences?.map(l => (
            <span key={l} style={{ fontFamily: C.mono, fontSize: 9, color: C.mid }}>{l}</span>
          ))}
        </div>
      </div>

      {/* PIN indicator */}
      {pilot.pin && (
        <span style={{ fontFamily: C.mono, fontSize: 9, color: C.low }}>
          PIN ••••
        </span>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button onClick={() => onEdit(pilot)} style={{
          padding: '5px 12px', borderRadius: 5, cursor: 'pointer',
          background: 'transparent', border: `1px solid ${C.border}`,
          fontFamily: C.mono, fontSize: 9, color: C.mid,
        }}>EDIT</button>
        <button onClick={() => onDelete(pilot)} style={{
          padding: '5px 12px', borderRadius: 5, cursor: 'pointer',
          background: 'transparent', border: `1px solid rgba(239,68,68,0.25)`,
          fontFamily: C.mono, fontSize: 9, color: C.red,
        }}>✕</button>
      </div>
    </div>
  )
}

function AircraftRow({ ac, onEdit, onDelete }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 16px', background: C.surface,
      border: `1px solid ${C.border}`, borderRadius: 8,
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 8, flexShrink: 0,
        background: C.amber10, border: `1px solid ${C.amber}44`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: C.mono, fontSize: 9, fontWeight: 700, color: C.amber,
      }}>
        {ac.typeDesig || '?'}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 700, color: C.text }}>
          {ac.callSign || ac.registration}
        </div>
        <div style={{ fontFamily: C.mono, fontSize: 9, color: C.mid, marginTop: 3 }}>
          {ac.registration}
          {ac.typeDesig && ac.typeDesig !== ac.callSign ? ` · ${ac.typeDesig}` : ''}
          {ac.homeBase ? ` · ${ac.homeBase}` : ''}
          {ac.icao24   ? ` · ${ac.icao24}`   : ''}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button onClick={() => onEdit(ac)} style={{
          padding: '5px 12px', borderRadius: 5, cursor: 'pointer',
          background: 'transparent', border: `1px solid ${C.border}`,
          fontFamily: C.mono, fontSize: 9, color: C.mid,
        }}>EDIT</button>
        <button onClick={() => onDelete(ac)} style={{
          padding: '5px 12px', borderRadius: 5, cursor: 'pointer',
          background: 'transparent', border: `1px solid rgba(239,68,68,0.25)`,
          fontFamily: C.mono, fontSize: 9, color: C.red,
        }}>✕</button>
      </div>
    </div>
  )
}

// ─── Tab button ───────────────────────────────────────────────────────────────
function TabBtn({ label, count, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 7,
      padding: '7px 16px', borderRadius: 7, cursor: 'pointer',
      border: `1px solid ${active ? C.amber : C.border}`,
      background: active ? C.amber10 : 'transparent',
      transition: 'all 0.15s',
    }}>
      <span style={{
        fontFamily: C.mono, fontSize: 10, fontWeight: 700,
        letterSpacing: '0.08em', color: active ? C.amber : C.mid,
      }}>{label}</span>
      <span style={{
        fontFamily: C.mono, fontSize: 10, fontWeight: 700,
        color: active ? C.amber : C.low,
        background: active ? C.amber20 : C.bg,
        padding: '1px 7px', borderRadius: 4,
      }}>{count}</span>
    </button>
  )
}

// ─── Main AdminPage ───────────────────────────────────────────────────────────
export default function AdminPage({ role }) {
  const [tab,      setTab]      = useState('PILOTS')
  const [pilots,   setPilots]   = useState([])
  const [aircraft, setAircraft] = useState([])
  const [loading,  setLoading]  = useState(true)

  // Form state
  const [pilotForm,    setPilotForm]    = useState(null)   // null = closed
  const [aircraftForm, setAircraftForm] = useState(null)
  const [editId,       setEditId]       = useState(null)
  const [saving,       setSaving]       = useState(false)
  const [error,        setError]        = useState('')

  // Load data
  useEffect(() => {
    Promise.all([
      getDocs(query(collection(db, 'pilots'),   orderBy('lastName'))),
      getDocs(query(collection(db, 'aircraft'), orderBy('registration'))),
    ]).then(([ps, as]) => {
      setPilots(ps.docs.map(d => ({ id: d.id, ...d.data() })))
      setAircraft(as.docs.map(d => ({ id: d.id, ...d.data() })))
      setLoading(false)
    }).catch(e => { console.error(e); setLoading(false) })
  }, [])

  const allTrigrams = pilots.map(p => p.trigram).filter(Boolean)

  // ── Pilot CRUD ──────────────────────────────────────────────────────────────
  const openNewPilot  = () => { setEditId(null); setPilotForm({ ...EMPTY_PILOT }); setError('') }
  const openEditPilot = (p) => { setEditId(p.id); setPilotForm({ ...EMPTY_PILOT, ...p, isInstructor: p.isInstructor ?? false, _origTrigram: p.trigram }); setError('') }

  const savePilot = async () => {
    if (!pilotForm.firstName || !pilotForm.lastName) return setError('First and last name required')
    if (!pilotForm.trigram || pilotForm.trigram.length !== 3) return setError('Trigram must be 3 characters')
    setSaving(true); setError('')
    try {
      const data = {
        firstName:     pilotForm.firstName,
        lastName:      pilotForm.lastName,
        email:         pilotForm.email,
        role:          pilotForm.role,
        licence:       pilotForm.licence,
        isInstructor:  pilotForm.licence === 'student' ? false : (pilotForm.isInstructor ?? false),
        birthDate:     pilotForm.birthDate,
        licenceDate:   pilotForm.licenceDate,
        licences:      pilotForm.licences,
        trigram:       pilotForm.trigram.toUpperCase(),
        pin:           pilotForm.pin,
        updatedAt:     serverTimestamp(),
      }
      if (editId) {
        await updateDoc(doc(db, 'pilots', editId), data)
        setPilots(prev => prev.map(p => p.id === editId ? { ...p, ...data, id: editId } : p))
      } else {
        const ref = await addDoc(collection(db, 'pilots'), { ...data, createdAt: serverTimestamp() })
        setPilots(prev => [...prev, { ...data, id: ref.id }])
      }
      setPilotForm(null); setEditId(null)
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  const deletePilot = async (p) => {
    if (!window.confirm(`Delete pilot ${p.firstName} ${p.lastName}?`)) return
    await deleteDoc(doc(db, 'pilots', p.id))
    setPilots(prev => prev.filter(x => x.id !== p.id))
  }

  // ── Aircraft CRUD ───────────────────────────────────────────────────────────
  const openNewAircraft  = () => { setEditId(null); setAircraftForm({ ...EMPTY_AIRCRAFT }); setError('') }
  const openEditAircraft = (a) => { setEditId(a.id); setAircraftForm({ ...a }); setError('') }

  const saveAircraft = async () => {
    if (!aircraftForm.registration) return setError('Registration required')
    setSaving(true); setError('')
    try {
      const data = {
        registration: aircraftForm.registration,
        callSign:     aircraftForm.callSign,
        typeDesig:    aircraftForm.typeDesig,
        icao24:       aircraftForm.icao24,
        homeBase:     aircraftForm.homeBase,
        updatedAt:    serverTimestamp(),
      }
      if (editId) {
        await updateDoc(doc(db, 'aircraft', editId), data)
        setAircraft(prev => prev.map(a => a.id === editId ? { ...a, ...data, id: editId } : a))
      } else {
        const ref = await addDoc(collection(db, 'aircraft'), { ...data, createdAt: serverTimestamp() })
        setAircraft(prev => [...prev, { ...data, id: ref.id }])
      }
      setAircraftForm(null); setEditId(null)
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  const deleteAircraft = async (a) => {
    if (!window.confirm(`Delete aircraft ${a.registration}?`)) return
    await deleteDoc(doc(db, 'aircraft', a.id))
    setAircraft(prev => prev.filter(x => x.id !== a.id))
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{
      width: '100%', height: '100%', background: C.bg,
      display: 'flex', flexDirection: 'column',
      fontFamily: C.mono, overflow: 'hidden',
    }}>

      {/* Top bar */}
      <div style={{
        background: C.surface, borderBottom: `1px solid ${C.border}`,
        padding: '12px 24px', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <TabBtn label="PILOTS"   count={pilots.length}   active={tab === 'PILOTS'}   onClick={() => { setTab('PILOTS'); setPilotForm(null); setAircraftForm(null) }} />
        <TabBtn label="AIRCRAFT" count={aircraft.length} active={tab === 'AIRCRAFT'} onClick={() => { setTab('AIRCRAFT'); setPilotForm(null); setAircraftForm(null) }} />

        <div style={{ flex: 1 }} />

        {tab === 'PILOTS' && !pilotForm && (
          <button onClick={openNewPilot} style={{
            padding: '7px 16px', borderRadius: 7, cursor: 'pointer',
            background: C.text, border: 'none',
            fontFamily: C.mono, fontSize: 10, fontWeight: 700,
            color: '#ffffff', letterSpacing: '0.05em',
          }}>+ NEW PILOT</button>
        )}
        {tab === 'AIRCRAFT' && !aircraftForm && (
          <button onClick={openNewAircraft} style={{
            padding: '7px 16px', borderRadius: 7, cursor: 'pointer',
            background: C.text, border: 'none',
            fontFamily: C.mono, fontSize: 10, fontWeight: 700,
            color: '#ffffff', letterSpacing: '0.05em',
          }}>+ NEW AIRCRAFT</button>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px' }}>
        {loading && (
          <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 60 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              border: `2px solid ${C.border}`, borderTop: `2px solid ${C.amber}`,
              animation: 'admin-spin 0.8s linear infinite',
            }} />
            <style>{`@keyframes admin-spin { to { transform: rotate(360deg) } }`}</style>
          </div>
        )}

        {!loading && tab === 'PILOTS' && (
          <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Form */}
            {pilotForm && (
              <PilotForm
                form={pilotForm}
                setForm={setPilotForm}
                allTrigrams={allTrigrams}
                saving={saving}
                error={error}
                onSave={savePilot}
                onCancel={() => { setPilotForm(null); setEditId(null); setError('') }}
                isEdit={!!editId}
              />
            )}

            {/* List */}
            {pilots.length === 0 && !pilotForm && (
              <div style={{ textAlign: 'center', color: C.low, fontSize: 12, paddingTop: 40 }}>
                No pilots yet. Click + NEW PILOT to add one.
              </div>
            )}
            {pilots.map(p => (
              <PilotRow
                key={p.id} pilot={p}
                onEdit={openEditPilot}
                onDelete={deletePilot}
              />
            ))}
          </div>
        )}

        {!loading && tab === 'AIRCRAFT' && (
          <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Form */}
            {aircraftForm && (
              <AircraftForm
                form={aircraftForm}
                setForm={setAircraftForm}
                saving={saving}
                error={error}
                onSave={saveAircraft}
                onCancel={() => { setAircraftForm(null); setEditId(null); setError('') }}
                isEdit={!!editId}
              />
            )}

            {/* List */}
            {aircraft.length === 0 && !aircraftForm && (
              <div style={{ textAlign: 'center', color: C.low, fontSize: 12, paddingTop: 40 }}>
                No aircraft yet. Click + NEW AIRCRAFT to add one.
              </div>
            )}
            {aircraft.map(a => (
              <AircraftRow
                key={a.id} ac={a}
                onEdit={openEditAircraft}
                onDelete={deleteAircraft}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
