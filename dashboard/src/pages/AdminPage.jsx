import { useState, useEffect, useRef } from 'react'
import { fetchWebPhoto, fetchHexForReg } from '../lib/webphoto'
import {
  collection, getDocs, addDoc, updateDoc, setDoc, deleteDoc,
  doc, serverTimestamp, query, where,
} from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage, auth, functions } from '../firebase/config'
import { httpsCallable } from 'firebase/functions'
import { useClub } from '../contexts/ClubContext'
import { AIRCRAFT_TYPES, CAT_LABEL, findAircraftType } from '../data/aircraftTypes'
import {
  T, labelStyle, headingStyle, monoStyle,
  Button, StatusDot, DataTable, Tabs, Drawer, EmptyState, Banner,
} from '../components/ui'

// (2026-09-21, lot 02 B) Page restylée AirKi : jetons T, Tabs, Drawer, DataTable, Button, StatusDot.
// Logique inchangée (CRUD pilotes/avions/accès, archivage, codes d'invitation, trigramme/PIN, photos, hex).
// Règles : fond paper, cartes blanches bordées 1 px rule radius 6, pas d'ombre ; chiffres/identifiants en
// Geist Mono ; ambre jamais en texte ; JAMAIS de rouge (conflit = StatusDot caution, suppression = Button danger).

// ─── Constants ────────────────────────────────────────────────────────────────
const ROLES    = ['user', 'instructor', 'admin']
const LICENCES = ['PPL', 'ULM', 'LAPL', 'CPL', 'ATPL', 'IR', 'ME', 'Night']
// (2026-09-16) TYPE_DESIG figé retiré → base OACI Doc 8643 dans src/data/aircraftTypes.js (combobox + saisie libre)

// Libellés affichés des rôles de plateforme (la valeur stockée ne change pas).
const ROLE_LABEL = { user: 'Pilot', instructor: 'Instructor', admin: 'Admin', super_admin: 'Super admin' }
const roleLabel = (r) => ROLE_LABEL[r] || r || '—'

const EMPTY_PILOT = {
  firstName: '', lastName: '', email: '',
  role: 'user',
  licence: 'student',
  isInstructor: false,
  birthDate: '', licenceDate: '',
  licences: [], trigram: '', pin: '',
  clubId: '',
}
const EMPTY_AIRCRAFT = {
  registration: '', callSign: '', typeDesig: '', icao24: '', homeBase: '',
  ownership: 'club', ownerPilotId: '',   // 'club' = avion du club · 'owner' = privé (propriétaire = un pilote)
  photoUrl: '', photoStoragePath: '',
  photoCredit: '', photoLink: '', photoSource: '',   // (2026-08-31) photo web auto (planespotters)
}

// ─── Reusable form components (déclarés au niveau module : pas de remontage) ──
const fieldBase = {
  width: '100%', boxSizing: 'border-box', height: 34,
  background: T.card, border: T.border, borderRadius: T.radius.sm,
  color: T.ink, fontSize: 13, padding: '0 10px', outline: 'none',
}

const Label = ({ children }) => (
  <div style={{ ...labelStyle(T.etch), marginBottom: 6 }}>{children}</div>
)

const Hint = ({ children }) => (
  <div style={{ fontFamily: T.sans, fontSize: 12, lineHeight: 1.4, color: T.graphite, marginTop: 4 }}>{children}</div>
)

const Input = ({ value, onChange, placeholder, type = 'text', maxLength, mono = false }) => (
  <input
    type={type} value={value} onChange={e => onChange(e.target.value)}
    placeholder={placeholder} maxLength={maxLength} className="ak-focus"
    style={{ ...fieldBase, fontFamily: mono ? T.mono : T.sans, fontVariantNumeric: mono ? 'tabular-nums' : undefined }}
  />
)

const Select = ({ value, onChange, options }) => (
  <select
    value={value} onChange={e => onChange(e.target.value)} className="ak-focus"
    style={{ ...fieldBase, fontFamily: T.sans, cursor: 'pointer' }}
  >
    {options.map(o => (
      <option key={o.value} value={o.value}>{o.label}</option>
    ))}
  </select>
)

// Champ en lecture seule (club courant, rôle super_admin).
const ReadOnly = ({ children, mono = false }) => (
  <div style={{
    ...fieldBase, display: 'flex', alignItems: 'center', background: T.paper, color: T.graphite,
    fontFamily: mono ? T.mono : T.sans,
  }}>
    {children}
  </div>
)

// Puce bordée (badges STUDENT / PILOT / FI / ARCHIVED / OWNER / CLUB, ratings).
const Chip = ({ children, strong = false, title }) => (
  <span title={title} style={{
    display: 'inline-flex', alignItems: 'center', height: 20, padding: '0 6px',
    border: `1px solid ${strong ? T.ink : T.rule}`, borderRadius: T.radius.sm,
    fontFamily: T.mono, fontSize: 10, fontWeight: 500, letterSpacing: '0.06em',
    color: strong ? T.ink : T.graphite, background: T.card, whiteSpace: 'nowrap',
  }}>{children}</span>
)

// Bascule segmentée / puce sélectionnable (aria-pressed) : actif = encre, texte blanc.
const Toggle = ({ active, onClick, children, mono = false, style }) => (
  <button
    type="button" aria-pressed={active} onClick={onClick} className="ak-focus"
    style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      height: 28, padding: '0 10px', borderRadius: T.radius.sm, cursor: 'pointer',
      border: `1px solid ${active ? T.ink : T.rule}`, background: active ? T.ink : T.card,
      color: active ? T.white : T.graphite,
      fontFamily: mono ? T.mono : T.sans, fontSize: mono ? 11 : 13, fontWeight: mono ? 500 : 600,
      letterSpacing: mono ? '0.04em' : '-0.01em', whiteSpace: 'nowrap', ...style,
    }}
  >{children}</button>
)

// Section de tiroir : titre mono + filet au-dessus (sauf la première).
const Section = ({ title, first = false, children }) => (
  <section style={{
    borderTop: first ? 'none' : T.border,
    paddingTop: first ? 0 : 16, marginTop: first ? 0 : 16,
  }}>
    <div style={{ ...labelStyle(T.graphite), marginBottom: 12 }}>{title}</div>
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>{children}</div>
  </section>
)

const full = { gridColumn: '1/-1' }

// (2026-09-16) Type designator OACI : combobox (datalist) sur la base Doc 8643 + saisie LIBRE d'un code
// hors liste (5 car. max, majuscules). Affiche le modèle reconnu sous le champ, ou « code libre ».
const TypeDesigInput = ({ value, onChange }) => {
  const known = findAircraftType(value)
  return (
    <div>
      <input
        list="ac-type-desig-list" value={value} className="ak-focus"
        onChange={e => onChange(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5))}
        placeholder="FK9, VL3, P28A, DR40…" maxLength={5} spellCheck={false}
        style={{ ...fieldBase, fontFamily: T.mono }}
      />
      <datalist id="ac-type-desig-list">
        {AIRCRAFT_TYPES.map(t => (
          <option key={t.code} value={t.code}>{`${t.name} · ${CAT_LABEL[t.cat] || t.cat}`}</option>
        ))}
      </datalist>
      <Hint>
        {value
          ? (known ? `${known.name} · ${CAT_LABEL[known.cat] || known.cat}` : 'Custom code — check it against ICAO Doc 8643')
          : 'ICAO Doc 8643 designator (pick from the list or type your own)'}
      </Hint>
    </div>
  )
}

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

const trigramConflictOf = (form, allTrigrams, isEdit) =>
  !!form && allTrigrams.filter(t => t !== (isEdit ? form._origTrigram : '')).includes((form.trigram || '').toUpperCase())

// ─── Pilot form (corps du tiroir) ─────────────────────────────────────────────
function PilotForm({ form, setForm, allTrigrams, currentClub, error, isEdit }) {
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

  const trigramConflict = trigramConflictOf(form, allTrigrams, isEdit)

  return (
    <div>
      {error && <Banner tone="caution" style={{ marginBottom: 16 }}>{error}</Banner>}

      <Section title="IDENTITY" first>
        <div>
          <Label>FIRST NAME</Label>
          <Input value={form.firstName} onChange={v => setForm(p => ({ ...p, firstName: v }))} placeholder="John" />
        </div>
        <div>
          <Label>LAST NAME</Label>
          <Input value={form.lastName} onChange={v => setForm(p => ({ ...p, lastName: v }))} placeholder="Smith" />
        </div>
        <div style={full}>
          <Label>EMAIL</Label>
          <Input value={form.email} onChange={v => setForm(p => ({ ...p, email: v }))} placeholder="john@example.com" type="email" />
        </div>
        <div>
          <Label>BIRTH DATE</Label>
          <Input type="date" mono value={form.birthDate} onChange={v => setForm(p => ({ ...p, birthDate: v }))} />
        </div>
        {/* Club — contexte d'opération, read-only */}
        <div>
          <Label>CLUB</Label>
          <ReadOnly mono>{currentClub ? currentClub.code : 'No club selected'}</ReadOnly>
        </div>
        <div style={full}>
          <Hint>
            {currentClub ? `${currentClub.name}. ` : ''}The pilot is created in this club. Switch club from the header to change it.
          </Hint>
        </div>
      </Section>

      <Section title="LICENCE & RATINGS">
        <div style={full}>
          <Label>FLYING QUALIFICATION</Label>
          <div style={{ display: 'flex', gap: 6 }}>
            {['student', 'pilot'].map(lic => (
              <Toggle key={lic} active={form.licence === lic} style={{ flex: 1 }}
                onClick={() => setForm(p => ({
                  ...p,
                  licence: lic,
                  isInstructor: lic === 'student' ? false : p.isInstructor,
                }))}
              >
                {lic === 'student' ? 'Student' : 'Pilot'}
              </Toggle>
            ))}
          </div>
        </div>

        {/* Is instructor — only if pilot */}
        {form.licence === 'pilot' && (
          <label style={{ ...full, display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer',
            padding: '10px 12px', border: `1px solid ${form.isInstructor ? T.ink : T.rule}`, borderRadius: T.radius.sm }}>
            <input
              type="checkbox" checked={!!form.isInstructor} className="ak-focus"
              onChange={() => setForm(p => ({ ...p, isInstructor: !p.isInstructor }))}
              style={{ width: 16, height: 16, margin: '2px 0 0', accentColor: T.ink, flexShrink: 0 }}
            />
            <span>
              <span style={{ display: 'block', fontFamily: T.sans, fontSize: 13, fontWeight: 600, color: T.ink }}>
                Certified instructor (FI)
              </span>
              <span style={{ display: 'block', fontFamily: T.sans, fontSize: 12, color: T.graphite, marginTop: 2 }}>
                Can supervise student flights
              </span>
            </span>
          </label>
        )}

        <div>
          <Label>LICENCE DATE</Label>
          <Input type="date" mono value={form.licenceDate} onChange={v => setForm(p => ({ ...p, licenceDate: v }))} />
        </div>
        <div />

        <div style={full}>
          <Label>RATINGS</Label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {LICENCES.map(lic => (
              <Toggle key={lic} mono active={form.licences.includes(lic)} onClick={() => toggleLicence(lic)}>
                {lic.toUpperCase()}
              </Toggle>
            ))}
          </div>
        </div>
      </Section>

      <Section title="PLATFORM ROLE">
        <div style={full}>
          <Label>ROLE</Label>
          {form.role === 'super_admin' ? (
            <>
              <ReadOnly>Super admin</ReadOnly>
              <Hint>Platform role — managed outside club administration. Not editable here.</Hint>
            </>
          ) : (
            <>
              <Select value={form.role} onChange={v => setForm(p => ({ ...p, role: v }))}
                options={ROLES.map(r => ({ value: r, label: roleLabel(r) }))} />
              <Hint>Page access and permissions</Hint>
            </>
          )}
        </div>
      </Section>

      <Section title="FDR">
        <div>
          <Label>TRIGRAM · 3 CHARS</Label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              value={form.trigram} className="ak-focus"
              onChange={e => setForm(p => ({ ...p, trigram: e.target.value.toUpperCase().slice(0, 3) }))}
              maxLength={3} aria-invalid={trigramConflict || undefined}
              style={{ ...fieldBase, flex: 1, minWidth: 0, fontFamily: T.mono, fontSize: 14, fontWeight: 500,
                letterSpacing: '0.2em', textAlign: 'center', borderColor: trigramConflict ? T.ink : T.rule }}
            />
            <Button size="md" onClick={autoTrigram} title="Generate a free trigram from the name">Auto</Button>
          </div>
          {trigramConflict && <StatusDot tone="caution" text="TRIGRAM ALREADY IN USE" style={{ marginTop: 6 }} />}
        </div>
        <div>
          <Label>PIN · 4 DIGITS</Label>
          <input
            type="password" value={form.pin} maxLength={4} inputMode="numeric" className="ak-focus"
            onChange={e => setForm(p => ({ ...p, pin: e.target.value.replace(/\D/g, '').slice(0, 4) }))}
            placeholder="••••"
            style={{ ...fieldBase, fontFamily: T.mono, fontSize: 16, letterSpacing: '0.4em', textAlign: 'center' }}
          />
          <Hint>Used to identify the pilot on the FDR</Hint>
        </div>
      </Section>
    </div>
  )
}

// ─── Aircraft photo uploader ──────────────────────────────────────────────────
function AircraftPhotoField({ form, setForm }) {
  const inputRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [err, setErr]             = useState('')

  const onFile = async (file) => {
    if (!file) return
    if (!file.type.startsWith('image/')) return setErr('Image file required')
    if (file.size > 5 * 1024 * 1024)     return setErr('Max 5 MB')
    setErr(''); setUploading(true)
    try {
      const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase()
      const reg  = (form.callSign || 'unknown').replace(/[^a-zA-Z0-9-]/g, '_')
      const path = `aircraft_photos/${reg}_${Date.now()}.${ext}`
      const r    = storageRef(storage, path)
      await uploadBytes(r, file)
      const url  = await getDownloadURL(r)
      setForm(p => ({ ...p, photoUrl: url, photoStoragePath: path }))
    } catch (e) { setErr(e.message) }
    finally { setUploading(false) }
  }

  const [fetching, setFetching] = useState(false)
  // AUTO (WEB) : cherche la photo par hex/immat sur planespotters → URL externe + crédit.
  const autoFetch = async () => {
    setErr(''); setFetching(true)
    const v = await fetchWebPhoto({ hex: form.icao24, reg: form.callSign })
    setFetching(false)
    if (!v) return setErr('No web photo found (fill in ICAO24 or call sign first)')
    setForm(p => ({ ...p, photoUrl: v.url, photoStoragePath: '', photoCredit: v.credit, photoLink: v.link, photoSource: v.site || 'planespotters.net' }))
  }

  const remove = () => setForm(p => ({ ...p, photoUrl: '', photoStoragePath: '', photoCredit: '', photoLink: '', photoSource: '' }))

  return (
    <div style={full}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <button
          type="button" className="ak-focus" onClick={() => inputRef.current?.click()}
          aria-label={form.photoUrl ? 'Replace photo' : 'Add photo'}
          style={{
            width: 192, height: 128, flexShrink: 0, padding: 0,
            borderRadius: T.radius.md, border: T.border, background: T.paper,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden', cursor: 'pointer',
          }}
        >
          {form.photoUrl
            ? <img src={form.photoUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
            : <span style={{ fontFamily: T.sans, fontSize: 13, color: T.graphite }}>Add photo</span>}
        </button>
        <div style={{ flex: '1 1 140px', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 }}>
          <Button size="sm" icon="upload" onClick={() => inputRef.current?.click()} disabled={uploading}>
            {uploading ? 'Uploading…' : form.photoUrl ? 'Replace' : 'Upload'}
          </Button>
          <Button size="sm" icon="search" onClick={autoFetch} disabled={fetching || uploading}
            title="Search planespotters.net for a photo (by ICAO24, otherwise by registration)">
            {fetching ? 'Searching…' : 'Find on the web'}
          </Button>
          {form.photoUrl && !uploading && (
            <Button size="sm" variant="danger" onClick={remove}>Remove</Button>
          )}
          {form.photoSource && form.photoUrl && (
            <a href={form.photoLink || '#'} target="_blank" rel="noreferrer"
              style={{ ...monoStyle(11, T.graphite), textDecoration: 'none' }}>
              © {form.photoCredit || '?'} · {form.photoSource}
            </a>
          )}
          {err && <StatusDot tone="caution" text={err} />}
        </div>
      </div>
      <input ref={inputRef} type="file" accept="image/*" style={{ display: 'none' }}
        onChange={e => onFile(e.target.files?.[0])} />
    </div>
  )
}

// ─── Aircraft form (corps du tiroir) ──────────────────────────────────────────
function HexLookupField({ form, setForm }) {
  const [state, setState] = useState('')   // '' | 'searching' | 'found:<src>' | 'notfound'
  const find = async () => {
    if (!form.callSign) return setState('notfound')
    setState('searching')
    const v = await fetchHexForReg(form.callSign)
    if (v?.hex) { setForm(p => ({ ...p, icao24: v.hex.toLowerCase() })); setState(`found:${v.source} (${v.reg})`) }
    else setState('notfound')
  }
  return (
    <div>
      <div style={{ display: 'flex', gap: 6 }}>
        <Input value={form.icao24} mono
          onChange={v => setForm(p => ({ ...p, icao24: v.toLowerCase() }))}
          placeholder="4401ab" maxLength={6} />
        <Button onClick={find} disabled={state === 'searching'} icon="search"
          title="Look up the Mode S hex from the registration (hexdb.io / adsbdb.com)">
          {state === 'searching' ? 'Searching…' : 'Find'}
        </Button>
      </div>
      {state.startsWith('found:') && (
        <StatusDot tone="ok" text={state.slice(6)} style={{ marginTop: 6 }} />
      )}
      {state === 'notfound' && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginTop: 6 }}>
          <StatusDot tone="caution" style={{ marginTop: 5 }} />
          <span style={{ fontFamily: T.sans, fontSize: 12, lineHeight: 1.4, color: T.graphite }}>
            Not found. Registries do not cover F-J aircraft, and the live source only answers while the
            aircraft is flying (try again in flight). Otherwise, look it up on FR24 and enter it by hand.
          </span>
        </div>
      )}
    </div>
  )
}

function AircraftForm({ form, setForm, error, pilots = [] }) {
  return (
    <div>
      {error && <Banner tone="caution" style={{ marginBottom: 16 }}>{error}</Banner>}

      <Section title="IDENTITY" first>
        <div>
          <Label>CALL SIGN</Label>
          <Input value={form.callSign} mono
            onChange={v => setForm(p => ({ ...p, callSign: v.toUpperCase() }))}
            placeholder="FJFVB" />
        </div>
        <div>
          <Label>HOME BASE · ICAO</Label>
          <Input value={form.homeBase} mono
            onChange={v => setForm(p => ({ ...p, homeBase: v.toUpperCase() }))}
            placeholder="EBBY" maxLength={4} />
        </div>
      </Section>

      <Section title="TYPE">
        <div style={full}>
          <Label>TYPE DESIGNATOR · ICAO</Label>
          <TypeDesigInput
            value={form.typeDesig}
            onChange={v => setForm(p => ({ ...p, typeDesig: v }))}
          />
        </div>
      </Section>

      <Section title="TRANSPONDER">
        <div style={full}>
          <Label>ICAO24 · HEX</Label>
          {/* (2026-08-31, demande Christophe) FIND (WEB) : immat → hex Mode S via hexdb.io/adsbdb.com
              (variantes avec tiret : OO-I44…). Couverture partielle — si introuvable, saisie
              manuelle (FR24 reste la meilleure source pour les ULM belges OO-I4x / français F-J). */}
          <HexLookupField form={form} setForm={setForm} />
        </div>
      </Section>

      <Section title="OWNERSHIP">
        <div>
          <Label>OWNERSHIP</Label>
          <Select
            value={form.ownership || 'club'}
            onChange={v => setForm(p => ({ ...p, ownership: v, ownerPilotId: v === 'club' ? '' : p.ownerPilotId }))}
            options={[{ value: 'club', label: 'Club aircraft' }, { value: 'owner', label: 'Private (owner)' }]}
          />
        </div>
        {form.ownership === 'owner' && (
          <div>
            <Label>OWNER · PILOT</Label>
            <Select
              value={form.ownerPilotId || ''}
              onChange={v => setForm(p => ({ ...p, ownerPilotId: v }))}
              options={[{ value: '', label: 'Select owner…' },
                ...pilots.map(p => ({ value: p.id, label: `${p.firstName} ${p.lastName}${p.trigram ? ` (${p.trigram})` : ''}` }))]}
            />
          </div>
        )}
      </Section>

      <Section title="PHOTO">
        <AircraftPhotoField form={form} setForm={setForm} />
      </Section>
    </div>
  )
}

// ─── Row pieces ───────────────────────────────────────────────────────────────
// (2026-09-21) Code d'invitation pour relier le compte d'un pilote à sa fiche (fonction cloud createPilotInvite).
// Usage unique, 14 jours ; un nouveau code révoque le précédent. Le code n'est affiché qu'ici, jamais stocké côté client.
function InviteCodeButton({ pilot }) {
  const [busy, setBusy] = useState(false)
  const [res, setRes]   = useState(null)   // { code, expiresAt } | { error }
  const gen = async () => {
    if (busy) return
    if (pilot.uid && !window.confirm(`${pilot.firstName || ''} ${pilot.lastName || ''} is already linked to an account. Create a new code to link another account?`)) return
    setBusy(true); setRes(null)
    try { const { data } = await httpsCallable(functions, 'createPilotInvite')({ pilotId: pilot.id }); setRes(data) }
    catch (e) { setRes({ error: e?.message || 'Could not create the code.' }) }
    finally { setBusy(false) }
  }
  const exp = res?.expiresAt ? new Date(res.expiresAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : ''
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
      {res?.code && (
        <span title={`Valid until ${exp}. Single use.`} style={{
          ...monoStyle(12, T.ink), letterSpacing: '0.1em', border: T.border, borderRadius: T.radius.sm,
          padding: '4px 8px', userSelect: 'all', background: T.paper,
        }}>
          {res.code}
        </span>
      )}
      {res?.code && (
        <Button size="sm" variant="ghost" onClick={() => navigator.clipboard?.writeText(res.code)}>Copy</Button>
      )}
      {res?.error && <StatusDot tone="caution" text={res.error} />}
      <Button size="sm" onClick={gen} disabled={busy}
        title="Create a single-use code the pilot enters after signing in (Google, Apple…)">
        {busy ? 'Creating…' : (res?.code ? 'New code' : 'Invite code')}
      </Button>
    </div>
  )
}

function AircraftThumb({ ac }) {
  // (2026-08-31) pas de photo enregistrée → tentative web auto (planespotters, cache 7 j).
  // Affichage seul : rien n'est écrit en base (l'admin fige via « Find on the web » + Save dans la fiche).
  const [webPhoto, setWebPhoto] = useState(null)
  useEffect(() => {
    if (ac.photoUrl || (!ac.icao24 && !ac.callSign)) return undefined
    let on = true
    fetchWebPhoto({ hex: ac.icao24, reg: ac.callSign }).then(v => { if (on && v?.url) setWebPhoto(v) })
    return () => { on = false }
  }, [ac.photoUrl, ac.icao24, ac.callSign])
  const photoUrl = ac.photoUrl || webPhoto?.url
  const photoTitle = ac.photoUrl
    ? (ac.photoSource ? `© ${ac.photoCredit || '?'} · ${ac.photoSource}` : '')
    : (webPhoto ? `© ${webPhoto.credit || '?'} · ${webPhoto.site || 'planespotters.net'}` : '')
  const box = { width: 56, height: 36, borderRadius: T.radius.sm, flexShrink: 0, border: T.border, display: 'block' }
  return photoUrl ? (
    <img src={photoUrl} alt="" title={photoTitle} style={{ ...box, objectFit: 'cover', filter: ac.archived ? 'grayscale(1)' : undefined }} />
  ) : (
    <div style={{ ...box, background: T.paper, display: 'flex', alignItems: 'center', justifyContent: 'center', ...monoStyle(10, T.etch) }}>
      {ac.typeDesig || '—'}
    </div>
  )
}

// Liste d'actions de fin de ligne.
const Actions = ({ children }) => (
  <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>{children}</div>
)

const sectionTitle = (text, count) => (
  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
    <span style={headingStyle(15)}>{text}</span>
    {count != null && <span style={monoStyle(12, T.etch)}>{count}</span>}
  </div>
)

// ─── Main AdminPage ───────────────────────────────────────────────────────────
export default function AdminPage() {
  // Le club courant vient du ClubContext (sélectionné via SelectClubPage pour
  // super_admin, ou imposé par users/{uid}.clubId pour admin de club).
  const { clubId, club } = useClub()

  const [tab,      setTab]      = useState('PILOTS')
  const [pilots,   setPilots]   = useState([])
  const [aircraft, setAircraft] = useState([])
  const [invites,  setInvites]  = useState([])   // (accès) invitations en attente/acceptées
  const [members,  setMembers]  = useState([])   // (accès) users rattachés à ce club
  const [loading,  setLoading]  = useState(true)

  // Form state
  const [pilotForm,    setPilotForm]    = useState(null)   // null = closed
  const [aircraftForm, setAircraftForm] = useState(null)
  const [inviteForm,   setInviteForm]   = useState(null)   // (accès) {email, role} ou null
  const [editId,       setEditId]       = useState(null)
  const [saving,       setSaving]       = useState(false)
  const [error,        setError]        = useState('')

  // Load data — toujours scopé sur le clubId courant (du ClubContext).
  // Tri client-side pour éviter les index composites Firestore.
  useEffect(() => {
    if (!clubId) { setLoading(false); return }
    setLoading(true)
    Promise.all([
      getDocs(query(collection(db, 'pilots'),   where('clubId', '==', clubId))),
      getDocs(query(collection(db, 'aircraft'), where('clubId', '==', clubId))),
      getDocs(query(collection(db, 'invites'),  where('clubId', '==', clubId))),
      getDocs(query(collection(db, 'users'),    where('clubId', '==', clubId))),
    ]).then(([ps, as, iv, us]) => {
      const pilotDocs    = ps.docs.map(d => ({ id: d.id, ...d.data() }))
      const aircraftDocs = as.docs.map(d => ({ id: d.id, ...d.data() }))
      const inviteDocs   = iv.docs.map(d => ({ id: d.id, ...d.data() }))
      const memberDocs   = us.docs.map(d => ({ id: d.id, ...d.data() }))
      pilotDocs.sort((a, b)    => (a.lastName     || '').localeCompare(b.lastName     || ''))
      aircraftDocs.sort((a, b) => ((a.callSign || a.registration || '')).localeCompare(b.callSign || b.registration || ''))
      inviteDocs.sort((a, b)   => (a.email        || '').localeCompare(b.email        || ''))
      memberDocs.sort((a, b)   => (a.email        || '').localeCompare(b.email        || ''))
      setPilots(pilotDocs)
      setAircraft(aircraftDocs)
      setInvites(inviteDocs)
      setMembers(memberDocs)
      setLoading(false)
    }).catch(e => { console.error('[AdminPage] load:', e); setLoading(false) })
  }, [clubId])

  // ── Accès (invitations) ───────────────────────────────────────────────────────
  const sendInvite = async () => {
    const email = (inviteForm?.email || '').trim().toLowerCase()
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setError('Valid email required')
    if (!clubId) return setError('No club context — please select a club first')
    setSaving(true); setError('')
    try {
      const data = {
        email, clubId, role: inviteForm.role || 'user',
        invitedByEmail: auth.currentUser?.email || null,
        status: 'pending', createdAt: serverTimestamp(),
      }
      await setDoc(doc(db, 'invites', email), data)   // id = email (allowlist)
      setInvites(prev => [...prev.filter(i => i.id !== email), { id: email, ...data }].sort((a, b) => a.email.localeCompare(b.email)))
      setInviteForm(null)
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  // Confirmation portée par le Button danger (confirm="…") : plus de window.confirm ici.
  const revokeInvite = async (inv) => {
    try { await deleteDoc(doc(db, 'invites', inv.id)); setInvites(prev => prev.filter(i => i.id !== inv.id)) }
    catch (e) { setError(e.message) }
  }

  const changeMemberRole = async (m, role) => {
    try { await updateDoc(doc(db, 'users', m.id), { role, updatedAt: serverTimestamp() })
      setMembers(prev => prev.map(x => x.id === m.id ? { ...x, role } : x)) }
    catch (e) { setError(e.message) }
  }

  const revokeMember = async (m) => {
    try { await updateDoc(doc(db, 'users', m.id), { clubId: '', role: 'user', updatedAt: serverTimestamp() })
      setMembers(prev => prev.filter(x => x.id !== m.id)) }
    catch (e) { setError(e.message) }
  }

  const allTrigrams = pilots.map(p => p.trigram).filter(Boolean)

  // ── Pilot CRUD ──────────────────────────────────────────────────────────────
  // clubId est toujours pré-rempli avec le club courant — l'utilisateur n'a
  // pas à le choisir, c'est le contexte d'opération.
  const openNewPilot  = () => { setEditId(null); setPilotForm({ ...EMPTY_PILOT, clubId }); setError('') }
  const openEditPilot = (p) => { setEditId(p.id); setPilotForm({ ...EMPTY_PILOT, ...p, licence: p.licence || 'pilot', isInstructor: p.isInstructor ?? false, _origTrigram: p.trigram })   /* (21/09) licence absente = breveté (règle isStudent) — plus d'écriture silencieuse de 'student' */; setError('') }

  const savePilot = async () => {
    if (!pilotForm.firstName || !pilotForm.lastName) return setError('First and last name required')
    if (!pilotForm.trigram || pilotForm.trigram.length !== 3) return setError('Trigram must be 3 characters')
    if (!clubId) return setError('No club context — please select a club first')
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
        clubId:        clubId,            // toujours le club courant du contexte
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
    await updateDoc(doc(db, 'pilots', p.id), { archived: true, updatedAt: serverTimestamp() })
    setPilots(prev => prev.filter(x => x.id !== p.id))
  }

  // ── Aircraft CRUD ───────────────────────────────────────────────────────────
  const openNewAircraft  = () => { setEditId(null); setAircraftForm({ ...EMPTY_AIRCRAFT }); setError('') }
  const openEditAircraft = (a) => { setEditId(a.id); setAircraftForm({ ...EMPTY_AIRCRAFT, ...a }); setError('') }

  const saveAircraft = async () => {
    if (!aircraftForm.callSign) return setError('Call sign required')
    if (!clubId) return setError('No club context — please select a club first')
    setSaving(true); setError('')
    try {
      const data = {
        // callSign = identifiant canonique. registration mirroré (legacy, retiré plus tard).
        registration:     aircraftForm.callSign,
        callSign:         aircraftForm.callSign,
        typeDesig:        aircraftForm.typeDesig,
        icao24:           aircraftForm.icao24,
        homeBase:         aircraftForm.homeBase,
        ownership:        aircraftForm.ownership || 'club',
        ownerPilotId:     aircraftForm.ownership === 'owner' ? (aircraftForm.ownerPilotId || '') : '',
        photoUrl:         aircraftForm.photoUrl || '',
        photoStoragePath: aircraftForm.photoStoragePath || '',
        photoCredit:      aircraftForm.photoCredit || '',
        photoLink:        aircraftForm.photoLink   || '',
        photoSource:      aircraftForm.photoSource || '',
        clubId:           clubId,        // toujours le club courant
        updatedAt:        serverTimestamp(),
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
    await updateDoc(doc(db, 'aircraft', a.id), { archived: true, updatedAt: serverTimestamp() })
    // (T18) on GARDE la ligne (badge ARCHIVED + Restore) au lieu de la masquer localement —
    // avant, l'avion disparaissait de l'écran mais REVENAIT au rechargement (aucune vue ne
    // filtrait archived) → « la suppression ne marche pas ». Les vues live filtrent désormais.
    setAircraft(prev => prev.map(x => x.id === a.id ? { ...x, archived: true } : x))
  }

  const restoreAircraft = async (a) => {
    await updateDoc(doc(db, 'aircraft', a.id), { archived: false, updatedAt: serverTimestamp() })
    setAircraft(prev => prev.map(x => x.id === a.id ? { ...x, archived: false } : x))
  }

  const closePilotForm    = () => { setPilotForm(null); setEditId(null); setError('') }
  const closeAircraftForm = () => { setAircraftForm(null); setEditId(null); setError('') }
  const switchTab = (k) => { setTab(k); setPilotForm(null); setAircraftForm(null) }

  const pendingInvites = invites.filter(i => i.status !== 'accepted')

  // ── Colonnes ────────────────────────────────────────────────────────────────
  const pilotColumns = [
    { key: 'trigram', label: 'TRIG', mono: true, width: 56,
      render: p => <span style={{ fontWeight: 500, letterSpacing: '0.08em' }}>{p.trigram || '—'}</span> },
    { key: 'name', label: 'PILOT',
      render: p => (
        <div style={{ minWidth: 140 }}>
          <div style={{ fontWeight: 600, color: T.ink }}>{p.firstName} {p.lastName}</div>
          {p.licences?.length > 0 && (
            <div style={{ ...monoStyle(11, T.graphite), marginTop: 2 }}>{p.licences.map(l => l.toUpperCase()).join(' · ')}</div>
          )}
        </div>
      ) },
    { key: 'qual', label: 'QUALIFICATION',
      render: p => (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <Chip>{p.licence === 'student' ? 'STUDENT' : 'PILOT'}</Chip>
          {p.isInstructor && <Chip strong>FI</Chip>}
        </div>
      ) },
    { key: 'role', label: 'ROLE', render: p => <span style={{ color: T.graphite }}>{roleLabel(p.role)}</span> },
    { key: 'pin', label: 'PIN',
      render: p => (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={monoStyle(13, p.pin ? T.ink : T.etch)}>{p.pin ? '••••' : '—'}</span>
          {/* PIN conflict warning — set by Cloud Function dedupPilotPin */}
          {p.pinConflict && (
            <span title="Another pilot in the same club has the same PIN. Edit one of them to fix it.">
              <StatusDot tone="caution" text="PIN CONFLICT" />
            </span>
          )}
        </div>
      ) },
    { key: 'account', label: 'ACCOUNT',
      render: p => (
        <span title={p.uid ? `Linked account: ${p.accountEmail || 'yes'}` : 'No dashboard account linked yet'}>
          <StatusDot tone={p.uid ? 'ok' : 'off'} text={p.uid ? 'LINKED' : 'NOT LINKED'} />
        </span>
      ) },
    { key: 'actions', label: '', align: 'right',
      render: p => (
        <Actions>
          <InviteCodeButton pilot={p} />
          <Button size="sm" icon="edit" onClick={() => openEditPilot(p)}>Edit</Button>
          <Button size="sm" variant="danger" icon="archive" confirm="Confirm archive"
            title={`Archive pilot ${p.firstName} ${p.lastName}`} onClick={() => deletePilot(p)}>Archive</Button>
        </Actions>
      ) },
  ]

  const aircraftColumns = [
    { key: 'photo', label: '', width: 72, render: a => <AircraftThumb ac={a} /> },
    { key: 'callSign', label: 'CALL SIGN', mono: true,
      render: a => (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 500, color: a.archived ? T.etch : T.ink }}>{a.callSign || a.registration}</span>
          {a.archived && <Chip>ARCHIVED</Chip>}
        </div>
      ) },
    { key: 'typeDesig', label: 'TYPE', mono: true,
      render: a => <span style={{ color: a.archived ? T.etch : T.ink }}>{a.typeDesig || '—'}</span> },
    { key: 'homeBase', label: 'BASE', mono: true,
      render: a => <span style={{ color: a.archived ? T.etch : T.ink }}>{a.homeBase || '—'}</span> },
    { key: 'icao24', label: 'ICAO24', mono: true,
      render: a => <span style={{ color: a.archived ? T.etch : T.ink }}>{a.icao24 || '—'}</span> },
    { key: 'ownership', label: 'OWNERSHIP',
      render: a => {
        const isOwner = a.ownership === 'owner'
        const owner = isOwner ? pilots.find(p => p.id === a.ownerPilotId) : null
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Chip strong={isOwner}>{isOwner ? 'OWNER' : 'CLUB'}</Chip>
            {isOwner && (
              <span style={{ color: a.archived ? T.etch : T.graphite }}>
                {owner ? `${owner.firstName} ${owner.lastName}` : '—'}
              </span>
            )}
          </div>
        )
      } },
    { key: 'actions', label: '', align: 'right',
      render: a => (
        <Actions>
          <Button size="sm" icon="edit" onClick={() => openEditAircraft(a)}>Edit</Button>
          {a.archived ? (
            <Button size="sm" icon="refresh" onClick={() => restoreAircraft(a)}>Restore</Button>
          ) : (
            <Button size="sm" variant="danger" icon="archive" confirm="Confirm archive"
              title={`Archive aircraft ${a.callSign || a.registration}`} onClick={() => deleteAircraft(a)}>Archive</Button>
          )}
        </Actions>
      ) },
  ]

  const memberColumns = [
    { key: 'name', label: 'NAME',
      render: m => <span style={{ fontWeight: 600 }}>{m.displayName || m.email}</span> },
    { key: 'email', label: 'EMAIL', mono: true, render: m => <span style={{ color: T.graphite }}>{m.email}</span> },
    { key: 'role', label: 'ROLE', width: 170,
      render: m => m.role === 'super_admin' ? (
        // super_admin : lecture seule — un select le rétrograderait.
        <span title="Platform role — not editable from club administration"><Chip strong>SUPER ADMIN</Chip></span>
      ) : (
        <select value={m.role || 'user'} onChange={e => changeMemberRole(m, e.target.value)} className="ak-focus"
          aria-label={`Role for ${m.email}`}
          style={{ ...fieldBase, height: 28, fontFamily: T.sans, cursor: 'pointer' }}>
          <option value="user">Pilot</option>
          <option value="instructor">Instructor</option>
          <option value="admin">Admin</option>
        </select>
      ) },
    { key: 'actions', label: '', align: 'right',
      render: m => (
        <Actions>
          <Button size="sm" variant="danger" confirm="Confirm revoke"
            title={`Revoke access for ${m.email}. They lose access at next sign-in.`}
            onClick={() => revokeMember(m)}>Revoke</Button>
        </Actions>
      ) },
  ]

  const inviteColumns = [
    { key: 'email', label: 'EMAIL', mono: true },
    { key: 'role', label: 'INVITED AS', render: i => <span style={{ color: T.graphite }}>{roleLabel(i.role || 'user')}</span> },
    { key: 'status', label: 'STATUS', render: () => <StatusDot tone="caution" text="WAITING FOR FIRST SIGN-IN" /> },
    { key: 'actions', label: '', align: 'right',
      render: inv => (
        <Actions>
          <Button size="sm" variant="danger" confirm="Confirm revoke"
            title={`Revoke invitation for ${inv.email}`} onClick={() => revokeInvite(inv)}>Revoke</Button>
        </Actions>
      ) },
  ]

  const pilotIsEdit = !!editId && !!pilotForm
  const pilotConflict = trigramConflictOf(pilotForm, allTrigrams, pilotIsEdit)

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{
      width: '100%', height: '100%', background: T.paper,
      display: 'flex', flexDirection: 'column',
      fontFamily: T.sans, color: T.ink, overflow: 'hidden',
    }}>

      {/* Top bar */}
      <div style={{
        padding: '16px 24px', flexShrink: 0, borderBottom: T.border,
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}>
        <Tabs
          ariaLabel="Admin sections"
          value={tab}
          onChange={switchTab}
          tabs={[
            { key: 'PILOTS',   label: 'Pilots',   count: pilots.length },
            { key: 'AIRCRAFT', label: 'Aircraft', count: aircraft.length },
            { key: 'ACCESS',   label: 'Access',   count: members.length + invites.length },
          ]}
        />

        <div style={{ flex: 1 }} />

        {tab === 'PILOTS' && (
          <Button variant="primary" onClick={openNewPilot}>New pilot</Button>
        )}
        {tab === 'AIRCRAFT' && (
          <Button variant="primary" onClick={openNewAircraft}>New aircraft</Button>
        )}
        {tab === 'ACCESS' && !inviteForm && (
          <Button variant="primary" onClick={() => { setInviteForm({ email: '', role: 'user' }); setError('') }}>Invite person</Button>
        )}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px 32px' }}>
        <div style={{ maxWidth: 1120, display: 'flex', flexDirection: 'column', gap: 20 }}>

          {tab === 'PILOTS' && (
            <DataTable
              columns={pilotColumns} rows={pilots} loading={loading}
              empty={<EmptyState text="No pilots yet." actionLabel="New pilot" onAction={openNewPilot} />}
            />
          )}

          {tab === 'AIRCRAFT' && (
            <DataTable
              columns={aircraftColumns} loading={loading}
              rows={[...aircraft].sort((x, y) => (x.archived ? 1 : 0) - (y.archived ? 1 : 0))}
              empty={<EmptyState text="No aircraft yet." actionLabel="New aircraft" onAction={openNewAircraft} />}
            />
          )}

          {tab === 'ACCESS' && (
            <>
              {error && !inviteForm && (
                <Banner tone="caution" action={<Button size="sm" variant="ghost" onClick={() => setError('')}>Dismiss</Button>}>
                  {error}
                </Banner>
              )}

              {/* Invite form */}
              {inviteForm && (
                <div style={{ background: T.card, border: T.border, borderRadius: T.radius.md, padding: 16 }}>
                  <div style={{ ...headingStyle(15), marginBottom: 12 }}>Invite a person</div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                    <label style={{ flex: 2, minWidth: 220, display: 'flex', flexDirection: 'column' }}>
                      <Label>EMAIL · GOOGLE ACCOUNT</Label>
                      <input type="email" value={inviteForm.email} autoFocus className="ak-focus"
                        onChange={e => setInviteForm(f => ({ ...f, email: e.target.value }))}
                        placeholder="person@gmail.com"
                        style={{ ...fieldBase, fontFamily: T.mono }} />
                    </label>
                    <label style={{ flex: 1, minWidth: 180, display: 'flex', flexDirection: 'column' }}>
                      <Label>ROLE</Label>
                      <select value={inviteForm.role} className="ak-focus"
                        onChange={e => setInviteForm(f => ({ ...f, role: e.target.value }))}
                        style={{ ...fieldBase, fontFamily: T.sans, cursor: 'pointer' }}>
                        <option value="user">Pilot — own flights</option>
                        <option value="instructor">Instructor — logbook</option>
                        <option value="admin">Admin — full club</option>
                      </select>
                    </label>
                    <Button variant="primary" onClick={sendInvite} disabled={saving}>
                      {saving ? 'Sending…' : 'Send invite'}
                    </Button>
                    <Button onClick={() => { setInviteForm(null); setError('') }}>Cancel</Button>
                  </div>
                  {error && <Banner tone="caution" style={{ marginTop: 12 }}>{error}</Banner>}
                  <div style={{ fontSize: 13, color: T.graphite, marginTop: 12, lineHeight: 1.5 }}>
                    The person signs in with this Google account and gets access to <strong style={{ color: T.ink }}>{club?.name || 'this club'}</strong> automatically.
                    Until then, they see an “Access pending” screen.
                  </div>
                </div>
              )}

              {/* Members (people with access now) */}
              <div>
                {sectionTitle('Members', members.length)}
                <DataTable
                  columns={memberColumns} rows={members} loading={loading}
                  empty={<EmptyState text="No one has access to this club yet." />}
                />
              </div>

              {/* Pending invites */}
              {!loading && pendingInvites.length > 0 && (
                <div>
                  {sectionTitle('Pending invites', pendingInvites.length)}
                  <DataTable columns={inviteColumns} rows={pendingInvites} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Pilot drawer */}
      <Drawer closeOnOverlay={false}
        open={!!pilotForm}
        onClose={closePilotForm}
        title={editId ? 'Edit pilot' : 'New pilot'}
        subtitle={pilotForm ? [pilotForm.trigram, club?.code].filter(Boolean).join(' · ') || undefined : undefined}
        footer={<>
          <Button onClick={closePilotForm}>Cancel</Button>
          <Button variant="primary" onClick={savePilot} disabled={saving || pilotConflict}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>}
      >
        {pilotForm && (
          <PilotForm
            form={pilotForm}
            setForm={setPilotForm}
            allTrigrams={allTrigrams}
            currentClub={club}
            error={error}
            isEdit={!!editId}
          />
        )}
      </Drawer>

      {/* Aircraft drawer */}
      <Drawer closeOnOverlay={false}
        open={!!aircraftForm}
        onClose={closeAircraftForm}
        title={editId ? 'Edit aircraft' : 'New aircraft'}
        subtitle={aircraftForm ? [aircraftForm.callSign, aircraftForm.typeDesig].filter(Boolean).join(' · ') || undefined : undefined}
        footer={<>
          <Button onClick={closeAircraftForm}>Cancel</Button>
          <Button variant="primary" onClick={saveAircraft} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>}
      >
        {aircraftForm && (
          <AircraftForm
            form={aircraftForm}
            setForm={setAircraftForm}
            pilots={pilots}
            error={error}
          />
        )}
      </Drawer>
    </div>
  )
}
