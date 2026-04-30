import { useState, useEffect } from 'react'
import {
  collection, doc, getDoc, setDoc, addDoc, updateDoc,
  onSnapshot, query, where, serverTimestamp
} from 'firebase/firestore'
import { db, auth } from '../firebase/config'

// ─── Règle absolue : text = #ffffff, borders/bg = rgba subtils ───────────────
const C = {
  bg:       '#050814',
  border:   'rgba(255,255,255,0.07)',
  amber:    '#F5A623',
  amber10:  'rgba(245,166,35,0.10)',
  amber20:  'rgba(245,166,35,0.20)',
  amber40:  'rgba(245,166,35,0.40)',
  green:    '#22c55e',
  red:      '#ef4444',
  red10:    'rgba(239,68,68,0.10)',
  inputBg:  'rgba(255,255,255,0.04)',
  rowBg:    'rgba(255,255,255,0.02)',
  // TEXT — toujours blanc
  text:     '#ffffff',
  mono:     'monospace',
}

const ROLES    = ['user', 'instructor', 'admin']
const ROLE_COLORS = { user: '#60a5fa', instructor: '#F5A623', admin: '#ef4444' }
const LICENCES = ['LAPL', 'PPL', 'CPL', 'ATPL', 'IR', 'ME', 'FI', 'CRI', 'ULM', 'Night']

// Désignateurs OACI types aéronefs — plans de vol
const AIRCRAFT_TYPES = [
  // ── ULM ──
  { value: 'VL3',    label: 'VL3    — JMB VL-3 Evolution' },
  { value: 'FK9',    label: 'FK9    — B&F Technik FK9 Mk IV' },
  { value: 'MCR01',  label: 'MCR01  — Dyn\'Aéro MCR-01' },
  { value: 'A22L',   label: 'A22L   — Aeroprakt A-22 Foxbat' },
  { value: 'ULAC',   label: 'ULAC   — ULM Aile Classique' },
  { value: 'TRIN',   label: 'TRIN   — Trixy Aviation G4' },
  { value: 'AVID',   label: 'AVID   — Avid Flyer' },
  { value: 'SAVI',   label: 'SAVI   — Savannah S' },
  { value: 'EURO',   label: 'EURO   — Eurostar EV-97' },
  { value: 'P92',    label: 'P92    — Tecnam P92 Echo' },
  // ── GA ──
  { value: 'C172',   label: 'C172   — Cessna 172 Skyhawk' },
  { value: 'C150',   label: 'C150   — Cessna 150/152' },
  { value: 'PA28',   label: 'PA28   — Piper PA-28 Cherokee' },
  { value: 'DR400',  label: 'DR400  — Robin DR400' },
  { value: 'TB10',   label: 'TB10   — Socata TB-10 Tobago' },
  { value: 'TB20',   label: 'TB20   — Socata TB-20 Trinidad' },
  { value: 'DA40',   label: 'DA40   — Diamond DA40' },
  { value: 'DA42',   label: 'DA42   — Diamond DA42 Twin Star' },
  { value: 'SR22',   label: 'SR22   — Cirrus SR22' },
  { value: 'BE35',   label: 'BE35   — Beechcraft Bonanza' },
]

// ─── Primitives ───────────────────────────────────────────────────────────────
function Label({ children }) {
  return <span style={{ fontFamily: C.mono, fontSize: 9, letterSpacing: '0.1em',
    color: C.text, display: 'block', marginBottom: 5, opacity: 0.6 }}>{children}</span>
}

function Input({ value, onChange, placeholder, type = 'text' }) {
  const [focus, setFocus] = useState(false)
  return (
    <input type={type} value={value ?? ''} onChange={e => onChange(e.target.value)}
      placeholder={placeholder} onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
      style={{
        width: '100%', background: C.inputBg,
        border: `1px solid ${focus ? C.amber40 : C.border}`,
        borderRadius: 6, padding: '8px 10px',
        fontFamily: C.mono, fontSize: 11, color: C.text,
        outline: 'none', transition: 'border-color 0.15s', boxSizing: 'border-box',
      }}
    />
  )
}

function Select({ value, onChange, options }) {
  return (
    <select value={value ?? ''} onChange={e => onChange(e.target.value)} style={{
      width: '100%', background: 'rgba(10,14,30,0.98)',
      border: `1px solid ${C.border}`, borderRadius: 6,
      padding: '8px 10px', fontFamily: C.mono, fontSize: 11,
      color: C.text, outline: 'none', cursor: 'pointer', boxSizing: 'border-box',
    }}>
      {options.map(o => <option key={o.value ?? o} value={o.value ?? o}
        style={{ background: '#0a0e1e' }}>{o.label ?? o}</option>)}
    </select>
  )
}

function Btn({ children, onClick, variant = 'primary', disabled, small }) {
  const s = {
    primary: { bg: C.amber10, border: C.amber20, color: C.amber },
    danger:  { bg: C.red10,   border: 'rgba(239,68,68,0.25)', color: C.red },
    ghost:   { bg: 'transparent', border: C.border, color: C.text },
  }[variant] ?? {}
  return (
    <button onClick={onClick} disabled={disabled} style={{
      background: s.bg, border: `1px solid ${s.border}`, color: s.color,
      borderRadius: 6, padding: small ? '4px 10px' : '8px 16px',
      fontFamily: C.mono, fontSize: small ? 9 : 10, fontWeight: 700,
      letterSpacing: '0.08em', cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1, transition: 'all 0.15s',
    }}>{children}</button>
  )
}

function RoleBadge({ role }) {
  const color = ROLE_COLORS[role] ?? C.text
  return <span style={{ fontFamily: C.mono, fontSize: 8, fontWeight: 700,
    letterSpacing: '0.1em', color, padding: '2px 6px', borderRadius: 4,
    border: `1px solid ${color}30`, background: `${color}10` }}>
    {role?.toUpperCase()}
  </span>
}

function Toast({ msg, type }) {
  if (!msg) return null
  const color = type === 'error' ? C.red : C.green
  return <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 999,
    padding: '10px 16px', borderRadius: 8, background: `${color}15`,
    border: `1px solid ${color}40`, fontFamily: C.mono, fontSize: 11, color,
    animation: 'fadeIn 0.2s ease' }}>{msg}</div>
}

// ─── CLUB ─────────────────────────────────────────────────────────────────────
function ClubTab({ clubId }) {
  const [club, setClub]   = useState({ name: '', icao: '', city: '', country: 'BE' })
  const [saving, setSaving] = useState(false)
  const [toast, setToast]   = useState(null)
  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000) }

  useEffect(() => {
    if (!clubId) return
    return onSnapshot(doc(db, 'clubs', clubId), snap => { if (snap.exists()) setClub(snap.data()) })
  }, [clubId])

  const save = async () => {
    setSaving(true)
    try { await setDoc(doc(db, 'clubs', clubId), { ...club, updatedAt: serverTimestamp() }, { merge: true }); showToast('Club saved ✓') }
    catch (e) { showToast(e.message, 'error') }
    setSaving(false)
  }

  return (
    <div style={{ maxWidth: 520 }}>
      <Toast msg={toast?.msg} type={toast?.type} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
        {[
          { key: 'name',    label: 'CLUB NAME',      col: '1/-1', ph: 'ULM Baisy-Thy' },
          { key: 'icao',    label: 'HOME BASE ICAO',  ph: 'EBBY' },
          { key: 'city',    label: 'CITY',            ph: 'Genappe' },
          { key: 'country', label: 'COUNTRY',         ph: 'BE' },
          { key: 'phone',   label: 'PHONE',           ph: '+32 ...' },
          { key: 'email',   label: 'EMAIL',           ph: 'contact@club.be' },
          { key: 'website', label: 'WEBSITE',         col: '1/-1', ph: 'https://...' },
        ].map(f => (
          <div key={f.key} style={{ gridColumn: f.col ?? 'auto' }}>
            <Label>{f.label}</Label>
            <Input value={club[f.key]} onChange={v => setClub(p => ({ ...p, [f.key]: v }))} placeholder={f.ph} />
          </div>
        ))}
      </div>
      <Btn onClick={save} disabled={saving}>{saving ? 'SAVING...' : 'SAVE CLUB'}</Btn>
    </div>
  )
}

// ─── AIRCRAFT ─────────────────────────────────────────────────────────────────
const EMPTY_AC = { registration: '', typeDesig: '', icao24: '', callSign: '', homeBase: '', active: true }

function AircraftTab({ clubId }) {
  const [aircraft, setAircraft] = useState([])
  const [form, setForm]         = useState(null)
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)
  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000) }

  useEffect(() => {
    if (!clubId) return
    return onSnapshot(query(collection(db, 'aircraft'), where('clubId', '==', clubId)),
      snap => setAircraft(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(a => a.archived !== true)))
  }, [clubId])

  const save = async () => {
    if (!form.registration || !form.icao24) return showToast('Registration and ICAO24 required', 'error')
    setSaving(true)
    try {
      const data = { ...form, clubId, archived: false, updatedAt: serverTimestamp() }
      if (form.id) { await updateDoc(doc(db, 'aircraft', form.id), data) }
      else { await addDoc(collection(db, 'aircraft'), { ...data, createdAt: serverTimestamp() }) }
      setForm(null)
      showToast(form.id ? 'Updated ✓' : 'Added ✓')
    } catch (e) {
      showToast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const archive = async id => {
    try { await updateDoc(doc(db, 'aircraft', id), { archived: true }); showToast('Removed ✓') }
    catch (e) { showToast(e.message, 'error') }
  }

  return (
    <div>
      <Toast msg={toast?.msg} type={toast?.type} />
      <div style={{ maxWidth: 680, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '12px 1fr 80px 90px 100px 1fr',
          gap: 12, padding: '4px 14px', marginBottom: 4, alignItems: 'center' }}>
          {['', 'REGISTRATION', 'TYPE', 'ICAO24', 'CALLSIGN', ''].map((h, i) => (
            <span key={i} style={{ fontFamily: C.mono, fontSize: 8, letterSpacing: '0.1em', color: C.amber, fontWeight: 700 }}>{h}</span>
          ))}
        </div>
        <div style={{ height: 1, background: C.border, marginBottom: 6 }} />
        {aircraft.length === 0 && <div style={{ fontFamily: C.mono, fontSize: 11, color: C.text, padding: '20px 0', opacity: 0.4 }}>No aircraft yet</div>}
        {aircraft.map(ac => (
          <div key={ac.id} style={{ display: 'grid', gridTemplateColumns: '12px 1fr 80px 90px 100px 1fr',
            gap: 12, alignItems: 'center',
            padding: '8px 14px', borderRadius: 6, background: C.rowBg, border: `1px solid ${C.border}`, marginBottom: 4 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: ac.active ? C.green : C.border }} />
            <span style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 700, color: C.text }}>{ac.registration}</span>
            <span style={{ fontFamily: C.mono, fontSize: 11, color: C.amber }}>{ac.typeDesig || ac.type}</span>
            <span style={{ fontFamily: C.mono, fontSize: 10, color: C.text, opacity: 0.7 }}>{ac.icao24}</span>
            <span style={{ fontFamily: C.mono, fontSize: 10, color: C.text, opacity: 0.7 }}>{ac.callSign}</span>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn small variant="ghost" onClick={() => setForm(ac)}>EDIT</Btn>
              <Btn small variant="danger" onClick={() => archive(ac.id)}>REMOVE</Btn>
            </div>
          </div>
        ))}
      </div>
      {!form && <Btn onClick={() => setForm({ ...EMPTY_AC })}>+ ADD AIRCRAFT</Btn>}
      {form && (
        <div style={{ marginTop: 16, padding: 20, borderRadius: 10, background: C.amber10, border: `1px solid ${C.amber20}`, maxWidth: 680 }}>
          <div style={{ fontFamily: C.mono, fontSize: 10, color: C.amber, letterSpacing: '0.12em', marginBottom: 16 }}>
            {form.id ? 'EDIT AIRCRAFT' : 'NEW AIRCRAFT'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <div>
              <Label>REGISTRATION</Label>
              <Input value={form.registration} onChange={v => setForm(p => ({ ...p, registration: v.toUpperCase() }))}
                placeholder="OO-E07, F-JFVB, G-ABCD" />
              <div style={{ fontFamily: C.mono, fontSize: 8, color: 'rgba(255,255,255,0.3)', marginTop: 3 }}>
                Immatriculation officielle avec tiret
              </div>
            </div>
            <div>
              <Label>TYPE OACI (plans de vol)</Label>
              <select value={form.typeDesig ?? ''} onChange={e => setForm(p => ({ ...p, typeDesig: e.target.value }))} style={{
                width: '100%', background: 'rgba(10,14,30,0.98)', border: `1px solid ${C.border}`,
                borderRadius: 6, padding: '8px 10px', fontFamily: C.mono, fontSize: 11,
                color: C.text, outline: 'none', cursor: 'pointer', boxSizing: 'border-box',
              }}>
                <option value="">Sélectionner un type…</option>
                {AIRCRAFT_TYPES.map(t => <option key={t.value} value={t.value} style={{ background: '#0a0e1e' }}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <Label>ICAO24 — CODE TRANSPONDEUR</Label>
              <Input value={form.icao24} onChange={v => setForm(p => ({ ...p, icao24: v.toUpperCase() }))}
                placeholder="ex: 44D074  (6 hex)" />
              <div style={{ fontFamily: C.mono, fontSize: 8, color: 'rgba(255,255,255,0.3)', marginTop: 3 }}>
                Mode S · évite les doublons ADS-B/SafeSky
              </div>
            </div>
            <div>
              <Label>CALLSIGN RADIO</Label>
              <Input value={form.callSign} onChange={v => setForm(p => ({ ...p, callSign: v.toUpperCase() }))}
                placeholder="ex: FJFVB, OOE07" />
              <div style={{ fontFamily: C.mono, fontSize: 8, color: 'rgba(255,255,255,0.3)', marginTop: 3 }}>
                Identifiant radio + SafeSky (sans tiret)
              </div>
            </div>
            <div>
              <Label>AÉRODROME DE BASE (ICAO)</Label>
              <Input value={form.homeBase} onChange={v => setForm(p => ({ ...p, homeBase: v.toUpperCase() }))}
                placeholder="EBBY" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <Btn onClick={save} disabled={saving}>{saving ? 'SAVING...' : 'SAVE'}</Btn>
            <Btn variant="ghost" onClick={() => setForm(null)}>CANCEL</Btn>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Génération trigramme avec détection de collision ────────────────────────
// Essai 1 : firstName[0] + lastName[0..1]   → CER
// Essai 2 : lastName[0]  + firstName[0..1]  → ECH  (nom puis prénom)
// Essai 3 : lastName[0..2]                  → ERK
// Essai 4 : firstName[0..2]                 → CHR
function generateTrigram(firstName, lastName, existingPilots, excludeId = null) {
  if (!firstName || !lastName) return ''
  const used = new Set(
    existingPilots
      .filter(p => p.id !== excludeId)
      .map(p => p.trigram?.toUpperCase())
      .filter(Boolean)
  )
  const fn = firstName.toUpperCase().replace(/[^A-Z]/g, '')
  const ln = lastName.toUpperCase().replace(/[^A-Z]/g, '')
  const candidates = [
    (fn[0] || '') + (ln[0] || '') + (ln[1] || ''),   // CER
    (ln[0] || '') + (fn[0] || '') + (fn[1] || ''),   // ECH
    (ln[0] || '') + (ln[1] || '') + (ln[2] || ''),   // ERK
    (fn[0] || '') + (fn[1] || '') + (fn[2] || ''),   // CHR
  ].map(c => c.padEnd(3, 'X').slice(0, 3)).filter(c => c.length === 3)
  return candidates.find(c => !used.has(c)) ?? candidates[0] ?? ''
}

// ─── PILOTS ───────────────────────────────────────────────────────────────────
const EMPTY_PILOT = {
  firstName: '', lastName: '', email: '',
  role: 'user',             // accès plateforme
  licence: 'student',       // qualification vol : 'student' | 'pilot'
  isInstructor: false,      // peut instruire (seulement si licence='pilot')
  birthDate: '', licenceDate: '', licences: [], trigram: '', pin: ''
}

function calcAge(birthDate) {
  if (!birthDate) return null
  const diff = Date.now() - new Date(birthDate).getTime()
  return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25))
}

function PilotsTab({ clubId }) {
  const [pilots, setPilots]     = useState([])
  const [form, setForm]         = useState(null)
  const [saving, setSaving]     = useState(false)
  const [toast, setToast]       = useState(null)
  const [expanded, setExpanded] = useState(null)
  const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000) }

  useEffect(() => {
    if (!clubId) return
    return onSnapshot(query(collection(db, 'pilots'), where('clubId', '==', clubId)),
      snap => setPilots(snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.archived !== true)))
  }, [clubId])

  const toggleLicence = lic => setForm(p => ({
    ...p, licences: p.licences.includes(lic) ? p.licences.filter(l => l !== lic) : [...p.licences, lic]
  }))

  const save = async () => {
    if (!form.lastName || !form.firstName) return showToast('Name required', 'error')
    if (form.pin && !/^\d{4}$/.test(form.pin)) return showToast('PIN — 4 chiffres exactement', 'error')
    setSaving(true)
    try {
      const trigram = (form.trigram?.length === 3)
        ? form.trigram.toUpperCase()
        : generateTrigram(form.firstName, form.lastName, pilots, form.id)
      const collision = pilots.find(p => p.id !== form.id && p.trigram?.toUpperCase() === trigram)
      if (collision) { showToast(`Trigramme ${trigram} déjà utilisé par ${collision.firstName} ${collision.lastName}`, 'error'); return }
      // Exclure les champs internes UI (_trigramManual)
      const { _trigramManual, ...rest } = form
      const data = { ...rest, trigram, clubId, archived: false, updatedAt: serverTimestamp() }
      if (form.id) { await updateDoc(doc(db, 'pilots', form.id), data) }
      else { await addDoc(collection(db, 'pilots'), { ...data, createdAt: serverTimestamp() }) }
      setForm(null)
      showToast(form.id ? 'Updated ✓' : 'Added ✓')
    } catch (e) {
      showToast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const archive = async id => {
    try { await updateDoc(doc(db, 'pilots', id), { archived: true }); showToast('Removed ✓') }
    catch (e) { showToast(e.message, 'error') }
  }

  return (
    <div>
      <Toast msg={toast?.msg} type={toast?.type} />
      <div style={{ maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
        {pilots.length === 0 && <div style={{ fontFamily: C.mono, fontSize: 11, color: C.text, padding: '20px 0', opacity: 0.4 }}>No pilots yet</div>}
        {pilots.map(p => (
          <div key={p.id} style={{ borderRadius: 8, border: `1px solid ${C.border}`, background: C.rowBg, overflow: 'hidden' }}>
            <div onClick={() => setExpanded(prev => prev === p.id ? null : p.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', cursor: 'pointer' }}>
              <div style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                background: `${ROLE_COLORS[p.role]}15`, border: `1px solid ${ROLE_COLORS[p.role]}30`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: C.mono, fontSize: 11, fontWeight: 700, color: ROLE_COLORS[p.role] ?? C.text }}>
                {(p.firstName?.[0] ?? '') + (p.lastName?.[0] ?? '')}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontFamily: C.mono, fontSize: 12, fontWeight: 700, color: C.text, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {p.firstName} {p.lastName}
                  {p.trigram && (
                    <span style={{ fontFamily: C.mono, fontSize: 10, fontWeight: 700, color: C.amber,
                      padding: '1px 7px', borderRadius: 4, border: `1px solid ${C.amber20}`,
                      background: C.amber10, letterSpacing: '0.1em' }}>
                      {p.trigram}
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
                  <RoleBadge role={p.role} />
                  {p.licences?.map(l => <span key={l} style={{ fontFamily: C.mono, fontSize: 8,
                    color: C.text, padding: '1px 5px', border: `1px solid ${C.border}`, borderRadius: 3 }}>{l}</span>)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn small variant="ghost" onClick={e => { e.stopPropagation(); setForm({ ...EMPTY_PILOT, licences: [], ...p }) }}>EDIT</Btn>
                <Btn small variant="danger" onClick={e => { e.stopPropagation(); archive(p.id) }}>REMOVE</Btn>
              </div>
            </div>
            {expanded === p.id && (
              <div style={{ padding: '12px 14px', borderTop: `1px solid ${C.border}`,
                display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 12 }}>
                {[
                  ['EMAIL', p.email],
                  ['ÂGE', calcAge(p.birthDate) ? `${calcAge(p.birthDate)} y.o.` : null],
                  ['LICENCE DATE', p.licenceDate ? new Date(p.licenceDate).toLocaleDateString('en-GB') : null],
                  ['QUALIFICATION', p.licence === 'pilot' ? '✈ PILOT' : '🎓 STUDENT'],
                  ['INSTRUCTEUR', p.isInstructor ? '✓ OUI' : '—'],
                  ['TRIGRAMME', p.trigram || '—'],
                  ['PIN', p.pin ? '••••' : 'non défini'],
                ].map(([l, v]) => (
                  <div key={l}><Label>{l}</Label>
                    <span style={{ fontFamily: C.mono, fontSize: 10, color: C.text }}>{v || '—'}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      {!form && <Btn onClick={() => setForm({ ...EMPTY_PILOT, licences: [] })}>+ ADD PILOT</Btn>}
      {form && (
        <div style={{ marginTop: 16, padding: 20, borderRadius: 10, background: C.amber10, border: `1px solid ${C.amber20}`, maxWidth: 680 }}>
          <div style={{ fontFamily: C.mono, fontSize: 10, color: C.amber, letterSpacing: '0.12em', marginBottom: 16 }}>
            {form.id ? 'EDIT PILOT' : 'NEW PILOT'}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
            {[
              { key: 'firstName',   label: 'FIRST NAME',   ph: 'Jean' },
              { key: 'lastName',    label: 'LAST NAME',    ph: 'Dupont' },
              { key: 'email',       label: 'EMAIL',        ph: 'jean@club.be' },
              { key: 'birthDate',   label: 'DATE OF BIRTH', ph: '', type: 'date' },
              { key: 'licenceDate', label: 'LICENCE DATE', ph: '', type: 'date' },
            ].map(f => (
              <div key={f.key}>
                <Label>{f.label}</Label>
                <Input value={form[f.key]} onChange={v => {
                  // Quand prénom ou nom changent → recalculer le trigramme auto si pas de saisie manuelle
                  const updated = { ...form, [f.key]: v }
                  const isNameField = f.key === 'firstName' || f.key === 'lastName'
                  if (isNameField && !form._trigramManual) {
                    updated.trigram = generateTrigram(
                      f.key === 'firstName' ? v : form.firstName,
                      f.key === 'lastName'  ? v : form.lastName,
                      pilots, form.id
                    )
                  }
                  setForm(updated)
                }} placeholder={f.ph} type={f.type} />
              </div>
            ))}
            <div>
              <Label>RÔLE PLATEFORME</Label>
              <Select value={form.role} onChange={v => setForm(p => ({ ...p, role: v }))}
                options={ROLES.map(r => ({ value: r, label: r.toUpperCase() }))} />
              <div style={{ fontFamily: C.mono, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginTop: 3 }}>
                Accès aux pages dashboard
              </div>
            </div>

            {/* Qualification vol — séparée du rôle plateforme */}
            <div style={{ gridColumn: '1/-1' }}>
              <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '4px 0 14px' }} />
              <Label>QUALIFICATION VOL</Label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                {['student', 'pilot'].map(lic => {
                  const active = form.licence === lic
                  return (
                    <button key={lic} type="button"
                      onClick={() => setForm(p => ({ ...p, licence: lic, isInstructor: lic === 'student' ? false : p.isInstructor }))}
                      style={{
                        flex: 1, padding: '8px 0',
                        background: active ? C.amber10 : 'transparent',
                        border: `1px solid ${active ? C.amber40 : C.border}`,
                        color: active ? C.amber : C.text,
                        fontFamily: C.mono, fontSize: 11, fontWeight: active ? 700 : 400,
                        borderRadius: 6, cursor: 'pointer', letterSpacing: 0.5,
                      }}>
                      {lic === 'student' ? '🎓 STUDENT — en formation' : '✈ PILOT — breveté'}
                    </button>
                  )
                })}
              </div>
              {/* isInstructor — visible seulement si pilot */}
              {form.licence === 'pilot' && (
                <div
                  onClick={() => setForm(p => ({ ...p, isInstructor: !p.isInstructor }))}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '8px 12px', borderRadius: 6, cursor: 'pointer',
                    background: form.isInstructor ? C.amber10 : 'rgba(255,255,255,0.02)',
                    border: `1px solid ${form.isInstructor ? C.amber40 : C.border}`,
                  }}>
                  <div style={{
                    width: 16, height: 16, borderRadius: 4, flexShrink: 0,
                    background: form.isInstructor ? C.amber : 'transparent',
                    border: `1px solid ${form.isInstructor ? C.amber : 'rgba(255,255,255,0.3)'}`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, color: '#050814',
                  }}>
                    {form.isInstructor ? '✓' : ''}
                  </div>
                  <span style={{ fontFamily: C.mono, fontSize: 11, color: form.isInstructor ? C.amber : C.text }}>
                    Peut instruire d'autres pilotes
                  </span>
                </div>
              )}
            </div>
            <div>
              <Label>TRIGRAMME</Label>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <Input
                  value={form.trigram}
                  onChange={v => setForm(p => ({
                    ...p,
                    trigram: v.toUpperCase().replace(/[^A-Z]/g,'').slice(0, 3),
                    _trigramManual: v.length > 0,  // l'admin a saisi manuellement
                  }))}
                  placeholder="auto"
                />
                {/* Bouton reset → re-générer automatiquement */}
                {form._trigramManual && (
                  <button
                    type="button"
                    onClick={() => setForm(p => ({
                      ...p,
                      trigram: generateTrigram(form.firstName, form.lastName, pilots, form.id),
                      _trigramManual: false,
                    }))}
                    title="Regénérer automatiquement"
                    style={{ background: 'transparent', border: `1px solid ${C.border}`, color: C.amber,
                      fontFamily: C.mono, fontSize: 14, padding: '4px 8px', borderRadius: 5, cursor: 'pointer',
                      flexShrink: 0 }}
                  >↺</button>
                )}
              </div>
              <div style={{ fontFamily: C.mono, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginTop: 3 }}>
                {form._trigramManual ? '✎ Manuel — cliquer ↺ pour regénérer' : '⚡ Auto-généré · unique dans le club'}
              </div>
            </div>
            <div>
              <Label>CODE PIN (accès boîtier FDR)</Label>
              <Input value={form.pin} onChange={v => setForm(p => ({ ...p, pin: v.replace(/\D/g,'').slice(0,4) }))}
                placeholder="4 chiffres" type="password" />
              <div style={{ fontFamily: C.mono, fontSize: 8, color: 'rgba(255,255,255,0.4)', marginTop: 3 }}>
                4 chiffres · saisie sur écran T-RGB au démarrage
              </div>
            </div>
          </div>
          <div style={{ marginBottom: 16 }}>
            <Label>LICENCES & RATINGS</Label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {LICENCES.map(lic => {
                const checked = form.licences?.includes(lic)
                return <div key={lic} onClick={() => toggleLicence(lic)} style={{
                  padding: '4px 10px', borderRadius: 5, cursor: 'pointer',
                  border: `1px solid ${checked ? C.amber : C.border}`,
                  background: checked ? C.amber10 : 'transparent',
                  fontFamily: C.mono, fontSize: 9, fontWeight: 700,
                  color: checked ? C.amber : C.text, transition: 'all 0.15s',
                }}>{lic}</div>
              })}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <Btn onClick={save} disabled={saving}>{saving ? 'SAVING...' : 'SAVE'}</Btn>
            <Btn variant="ghost" onClick={() => setForm(null)}>CANCEL</Btn>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'club',     label: 'CLUB',     icon: '⬡' },
  { id: 'aircraft', label: 'AIRCRAFT', icon: '✈' },
  { id: 'pilots',   label: 'PILOTS',   icon: '◉' },
]

export default function AdminPage({ role }) {
  const [activeTab, setActiveTab] = useState('club')
  const [clubId, setClubId]       = useState(null)
  const [loading, setLoading]     = useState(true)

  useEffect(() => {
    const uid = auth.currentUser?.uid
    if (!uid) return
    getDoc(doc(db, 'users', uid))
      .then(snap => { setClubId(snap.data()?.clubId ?? 'club_aerobelgique'); setLoading(false) })
      .catch(() => { setClubId('club_aerobelgique'); setLoading(false) })
  }, [])

  if (role !== 'admin') return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', background: C.bg, fontFamily: C.mono, color: C.text, fontSize: 11 }}>
      ACCESS RESTRICTED — ADMIN ONLY
    </div>
  )
  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', background: C.bg, fontFamily: C.mono, color: C.text, fontSize: 11 }}>
      LOADING...
    </div>
  )

  return (
    <div style={{ display: 'flex', height: '100%', background: C.bg, overflow: 'hidden' }}>
      {/* Sidebar */}
      <div style={{ width: 160, flexShrink: 0, borderRight: `1px solid ${C.border}`,
        padding: '16px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ fontFamily: C.mono, fontSize: 8, letterSpacing: '0.15em',
          color: C.text, padding: '0 8px', marginBottom: 8, opacity: 0.5 }}>
          ADMINISTRATION
        </div>
        {TABS.map(tab => {
          const active = activeTab === tab.id
          return (
            <div key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 10px', borderRadius: 7, cursor: 'pointer',
              background: active ? C.amber10 : 'transparent',
              borderLeft: `2px solid ${active ? C.amber : 'transparent'}`,
              transition: 'all 0.15s',
            }}>
              <span style={{ fontSize: 10, color: active ? C.amber : C.text }}>{tab.icon}</span>
              <span style={{ fontFamily: C.mono, fontSize: 10, fontWeight: 700,
                letterSpacing: '0.08em', color: active ? C.amber : C.text }}>{tab.label}</span>
            </div>
          )
        })}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        <div style={{ fontFamily: C.mono, fontSize: 13, fontWeight: 700,
          color: C.text, letterSpacing: '0.1em', marginBottom: 20 }}>
          {TABS.find(t => t.id === activeTab)?.label}
        </div>
        {activeTab === 'club'     && <ClubTab     clubId={clubId} />}
        {activeTab === 'aircraft' && <AircraftTab clubId={clubId} />}
        {activeTab === 'pilots'   && <PilotsTab   clubId={clubId} />}
      </div>

      <style>{`
        @keyframes fadeIn { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:none } }
        input::placeholder { color: rgba(255,255,255,0.3) !important; }
        input[type=date]::-webkit-calendar-picker-indicator { filter: invert(1) opacity(0.4); }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
      `}</style>
    </div>
  )
}
