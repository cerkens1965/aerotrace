import { useState, useEffect, useRef } from 'react'
import { fetchWebPhoto, fetchHexForReg } from '../lib/webphoto'
import {
  collection, getDocs, addDoc, updateDoc, setDoc, deleteDoc,
  doc, serverTimestamp, query, where,
} from 'firebase/firestore'
import { sortOptions, compareText } from '../utils/sortOptions'
import { matches } from '../utils/search'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { db, storage, auth, functions } from '../firebase/config'
import { httpsCallable } from 'firebase/functions'
import { useClub } from '../contexts/ClubContext'
import AircraftPhoto from '../components/aircraft/AircraftPhoto'
import { photoFrame } from '../components/aircraft/photoFrame'
import { AIRCRAFT_TYPES, CAT_LABEL, findAircraftType } from '../data/aircraftTypes'
import {
  T, labelStyle, headingStyle, monoStyle,
  Button, StatusDot, DataTable, Tabs, Drawer, EmptyState, Banner, Input, Select, Chip, Toggle, Field, MetricCard, SearchBox,
} from '../components/ui'

// (22/09) Recherche : helpers partagés (utils/search) + SearchBox de la bibliothèque.

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
  // 'club' = avion du club · 'owner' = privé. (24/09) ownerPilotIds : UN nom = propriétaire,
  // PLUSIEURS = copropriété, et la copropriété change l'attribution des vols (cf. cloud).
  ownership: 'club', ownerPilotId: '', ownerPilotIds: [],
  photoUrl: '', photoStoragePath: '',
  photoCredit: '', photoLink: '', photoSource: '',   // (2026-08-31) photo web auto (planespotters)
  photoZoom: 1, photoX: 50, photoY: 50,              // (21/09) cadrage de la photo (zoom 1–3, point visé en %)
}

// ─── Reusable form components (déclarés au niveau module : pas de remontage) ──
// (22/09) Input, Select, Chip, Toggle viennent de la bibliothèque (components/ui) ; restent ici Label, Hint, ReadOnly, Section.
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

// Champ en lecture seule (club courant, rôle super_admin).
const ReadOnly = ({ children, mono = false }) => (
  <div style={{
    ...fieldBase, display: 'flex', alignItems: 'center', background: T.paper, color: T.graphite,
    fontFamily: mono ? T.mono : T.sans,
  }}>
    {children}
  </div>
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

// Propriétaires d'une fiche, quelle que soit sa génération (liste, sinon champ historique).
const ownerIdsOf = (a) => {
  const raw = Array.isArray(a?.ownerPilotIds) && a.ownerPilotIds.length ? a.ownerPilotIds : (a?.ownerPilotId ? [a.ownerPilotId] : [])
  return [...new Set(raw.filter(Boolean))]
}

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
        {[...AIRCRAFT_TYPES].sort((a, b) => compareText(a.code, b.code)).map(t => (
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

// (24/09) PROPRIÉTAIRES — un nom, ou plusieurs. « Plusieurs » n'est pas un détail de saisie :
// c'est ce qui décide si un vol est crédité tout seul ou s'il attend une réponse. Le texte
// sous le champ le dit à la ligne, au moment où on ajoute le deuxième nom — pas dans une
// documentation que personne ne lira.
//
// La liste `ownerPilotIds` est la source ; `ownerPilotId` (premier nom) reste écrit à
// l'enregistrement, parce que le reste du dashboard le lit encore.
function OwnersField({ form, setForm, pilots }) {
  const ids = Array.isArray(form.ownerPilotIds) && form.ownerPilotIds.length
    ? form.ownerPilotIds
    : (form.ownerPilotId ? [form.ownerPilotId] : [])
  const set = (next) => setForm(p => ({ ...p, ownerPilotIds: next, ownerPilotId: next[0] || '' }))
  const nameOf = (id) => {
    const p = pilots.find(x => x.id === id)
    return p ? `${p.firstName} ${p.lastName}${p.trigram ? ` (${p.trigram})` : ''}` : id
  }
  const free = pilots.filter(p => !ids.includes(p.id) && !p.archived)

  return (
    <div>
      <Label>{ids.length > 1 ? `OWNERS · ${ids.length}` : 'OWNER'}</Label>

      {ids.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
          {ids.map((id, i) => (
            <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 10,
              border: `1px solid ${T.rule}`, borderRadius: T.radius.sm, padding: '7px 10px', background: T.card }}>
              <span style={{ fontSize: 13, color: T.ink, flex: 1, minWidth: 0 }}>{nameOf(id)}</span>
              {i === 0 && ids.length > 1 && <span style={labelStyle(T.etch)}>MAIN</span>}
              <Button size="sm" variant="ghost" onClick={() => set(ids.filter(x => x !== id))}>Remove</Button>
            </div>
          ))}
        </div>
      )}

      <Select
        value=""
        onChange={v => { if (v) set([...ids, v]) }}
        options={sortOptions([
          { value: '', label: ids.length ? 'Add another owner…' : 'Select owner…' },
          ...free.map(p => ({ value: p.id, label: `${p.firstName} ${p.lastName}${p.trigram ? ` (${p.trigram})` : ''}` })),
        ])}
      />

      <Hint>
        {ids.length === 0
          ? 'Pick the pilot who owns this aircraft.'
          : ids.length === 1
            ? 'One owner: their flights are credited to them automatically.'
            : 'Shared ownership: flights are credited to nobody automatically. Each owner is asked on the AKview at start-up, and can confirm the flight afterwards in the logbook.'}
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
function PilotForm({ form, setForm, allTrigrams, currentClub, error, isEdit, pilot }) {
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
          {/* (22/09, Claude Design Admin) Student · Licensed · FI en bascules (FI réservé au breveté) */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Toggle active={form.licence === 'student'} onClick={() => setForm(p => ({ ...p, licence: 'student', isInstructor: false }))}>Student</Toggle>
            <Toggle active={form.licence !== 'student'} onClick={() => setForm(p => ({ ...p, licence: 'pilot' }))}>Licensed</Toggle>
            <Toggle mono active={!!form.isInstructor} disabled={form.licence === 'student'} title="Flight instructor: can supervise student flights"
              onClick={() => setForm(p => ({ ...p, isInstructor: !p.isInstructor }))}>FI</Toggle>
          </div>
          <Hint>{form.licence === 'student' ? 'A student flies with an instructor on board or on the ground.' : form.isInstructor ? 'Flight instructor: can supervise student flights.' : 'Licensed pilot: flights are solo unless an instructor is set.'}</Hint>
        </div>

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
          <Hint>Four digits keyed on the AKview to identify the pilot.</Hint>
          {form.pinConflict && <StatusDot tone="caution" text="DUPLICATE PIN IN THE CLUB" style={{ marginTop: 6 }} />}
        </div>
      </Section>

      <InviteSection pilot={isEdit ? pilot : null} />
    </div>
  )
}

// (22/09, Claude Design Admin) Code d'invitation dans le tiroir : parcours 1 GENERATE → 2 COPY → 3 PILOT SIGNS IN →
// 4 LINKED. Fonction cloud createPilotInvite (usage unique, 14 jours, révoque le code précédent). Code jamais stocké côté client.
function InviteSection({ pilot }) {
  const [busy, setBusy] = useState(false)
  const [res, setRes]   = useState(null)   // { code, expiresAt } | { error }
  const [copied, setCopied] = useState(false)
  const linked = !!pilot?.uid
  const gen = async () => {
    if (busy || !pilot) return
    setBusy(true); setRes(null); setCopied(false)
    try { const { data } = await httpsCallable(functions, 'createPilotInvite')({ pilotId: pilot.id }); setRes(data) }
    catch (e) { setRes({ error: e?.message || 'Could not create the code.' }) }
    finally { setBusy(false) }
  }
  const copy = () => { if (res?.code) { navigator.clipboard?.writeText(res.code); setCopied(true) } }
  const step = linked && !res?.code ? 4 : res?.code ? (copied ? 3 : 2) : 1
  const exp = res?.expiresAt ? new Date(res.expiresAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase() : ''
  const stepStyle = (n) => ({ ...labelStyle(n === step ? T.ink : T.etch), paddingBottom: 2, borderBottom: `1px solid ${n === step ? T.ink : 'transparent'}` })
  return (
    <section style={{ borderTop: T.border, paddingTop: 16, marginTop: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <span style={labelStyle(T.graphite)}>INVITATION CODE</span>
        {pilot && <StatusDot tone={linked ? 'ok' : 'caution'} text={linked ? 'LINKED' : 'NOT LINKED'} />}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={stepStyle(1)}>1 GENERATE</span><span style={labelStyle(T.etch)}>→</span>
        <span style={stepStyle(2)}>2 COPY</span><span style={labelStyle(T.etch)}>→</span>
        <span style={stepStyle(3)}>3 PILOT SIGNS IN</span><span style={labelStyle(T.etch)}>→</span>
        <span style={stepStyle(4)}>4 LINKED</span>
      </div>
      {!pilot ? (
        <div style={{ background: T.paper, border: T.border, borderRadius: T.radius.md, padding: 14, fontSize: 12, color: T.graphite }}>
          Save the pilot first, then generate a code here.
        </div>
      ) : res?.code ? (
        <div style={{ background: T.ink, borderRadius: T.radius.md, padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ ...monoStyle(26, T.white), letterSpacing: '0.12em', userSelect: 'all' }}>{res.code}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" variant="primary" onInk icon={copied ? 'check' : 'download'} onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
              <Button size="sm" onInk icon="refresh" onClick={gen} disabled={busy}>Replace</Button>
            </div>
          </div>
          <span style={labelStyle(T.mutedDark)}>SINGLE USE · VALID UNTIL {exp}</span>
        </div>
      ) : (
        <div style={{ background: T.paper, border: T.border, borderRadius: T.radius.md, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <span style={{ fontSize: 12, lineHeight: 1.5, color: T.graphite }}>
            {linked
              ? `Linked to ${pilot.accountEmail || 'a dashboard sign-in'}. Issue a new code only if the pilot loses access to that account.`
              : 'A single-use code, valid 14 days. The pilot keys it in once after signing in; any sign-in works, Google or Apple.'}
          </span>
          <div><Button size="sm" variant={linked ? 'ghost' : 'secondary'} icon="refresh" onClick={gen} disabled={busy}>{busy ? 'Creating…' : linked ? 'Generate a new code' : 'Generate a code'}</Button></div>
          {res?.error && <StatusDot tone="caution" text={res.error} />}
        </div>
      )}
    </section>
  )
}

// ─── Aircraft photo uploader ──────────────────────────────────────────────────
// (21/09) RECADREUR : cadre 4:3 (format des vignettes), glisser = déplacer le point visé, curseur = zoom 1–3,
// flèches clavier = déplacer, +/- = zoom. Le résultat (photoZoom / photoX / photoY) est enregistré avec la fiche.
function PhotoFramer({ form, setForm }) {
  const W = 192, H = 144
  const z = Number(form.photoZoom) || 1, x = Number(form.photoX ?? 50), y = Number(form.photoY ?? 50)
  const drag = useRef(null)
  const [dragging, setDragging] = useState(false)
  const clamp = (v) => Math.min(100, Math.max(0, v))
  const set = (patch) => setForm(p => ({ ...p, ...patch }))
  const onDown = (e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { px: e.clientX, py: e.clientY, x, y }; setDragging(true) }
  const onMove = (e) => {
    const d = drag.current; if (!d) return
    // glisser vers la droite = l'image suit le doigt = le point visé part vers la gauche
    set({ photoX: clamp(d.x - (e.clientX - d.px) / W * 100 / z * 1.6), photoY: clamp(d.y - (e.clientY - d.py) / H * 100 / z * 1.6) })
  }
  const onUp = () => { drag.current = null; setDragging(false) }
  const onKey = (e) => {
    const k = e.key, step = e.shiftKey ? 10 : 3
    if (k === 'ArrowLeft')  { e.preventDefault(); set({ photoX: clamp(x - step) }) }
    if (k === 'ArrowRight') { e.preventDefault(); set({ photoX: clamp(x + step) }) }
    if (k === 'ArrowUp')    { e.preventDefault(); set({ photoY: clamp(y - step) }) }
    if (k === 'ArrowDown')  { e.preventDefault(); set({ photoY: clamp(y + step) }) }
    if (k === '+' || k === '=') set({ photoZoom: Math.min(3, +(z + 0.1).toFixed(2)) })
    if (k === '-')              set({ photoZoom: Math.max(1, +(z - 0.1).toFixed(2)) })
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: W, flexShrink: 0 }}>
      <div role="img" aria-label="Photo framing — drag to position, arrow keys to move, + and − to zoom" tabIndex={0} className="ak-focus"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp} onKeyDown={onKey}
        style={{ width: W, height: H, borderRadius: T.radius.md, border: T.border, overflow: 'hidden', background: T.paper,
                 cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none' }}>
        <img src={form.photoUrl} alt="" draggable={false} style={{ ...photoFrame(form), pointerEvents: 'none' }} />
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...labelStyle(T.etch) }}>ZOOM</span>
        <input type="range" min={1} max={3} step={0.05} value={z} aria-label="Zoom"
          onChange={e => set({ photoZoom: Number(e.target.value) })}
          style={{ flex: 1, accentColor: T.ink }} />
        <span style={{ ...monoStyle(11, T.graphite), width: 34, textAlign: 'right' }}>{z.toFixed(1)}×</span>
      </label>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontFamily: T.sans, fontSize: 12, color: T.graphite }}>Drag to position</span>
        <Button size="sm" variant="ghost" onClick={() => set({ photoZoom: 1, photoX: 50, photoY: 50 })}>Reset</Button>
      </div>
    </div>
  )
}

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
      setForm(p => ({ ...p, photoUrl: url, photoStoragePath: path, photoZoom: 1, photoX: 50, photoY: 50 }))
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
    setForm(p => ({ ...p, photoUrl: v.url, photoStoragePath: '', photoCredit: v.credit, photoLink: v.link, photoSource: v.site || 'planespotters.net', photoZoom: 1, photoX: 50, photoY: 50 }))
  }

  const remove = () => setForm(p => ({ ...p, photoUrl: '', photoStoragePath: '', photoCredit: '', photoLink: '', photoSource: '', photoZoom: 1, photoX: 50, photoY: 50 }))

  return (
    <div style={full}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        {form.photoUrl ? <PhotoFramer form={form} setForm={setForm} /> : (
        <button
          type="button" className="ak-focus" onClick={() => inputRef.current?.click()}
          aria-label="Add photo"
          style={{
            width: 192, height: 144, flexShrink: 0, padding: 0,
            borderRadius: T.radius.md, border: T.border, background: T.paper,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden', cursor: 'pointer',
          }}
        >
          <span style={{ fontFamily: T.sans, fontSize: 13, color: T.graphite }}>Add photo</span>
        </button>)}
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

function AircraftForm({ form, setForm, error, pilots = [], typePicks = [], types = {} }) {
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
          {typePicks.length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
              {typePicks.map(t => (
                <Toggle key={t} mono active={form.typeDesig === t} title={findAircraftType(t)?.name || t}
                  onClick={() => setForm(p => ({ ...p, typeDesig: t }))}>{t}</Toggle>
              ))}
            </div>
          )}
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
        <div style={full}>
          <Label>OWNERSHIP</Label>
          <div style={{ display: 'flex', gap: 6 }}>
            <Toggle active={(form.ownership || 'club') === 'club'} onClick={() => setForm(p => ({ ...p, ownership: 'club', ownerPilotId: '', ownerPilotIds: [] }))}>Club</Toggle>
            <Toggle active={form.ownership === 'owner'} onClick={() => setForm(p => ({ ...p, ownership: 'owner' }))}>Private owner</Toggle>
          </div>
        </div>
        {form.ownership === 'owner' && (
          <div style={full}><OwnersField form={form} setForm={setForm} pilots={pilots} /></div>
        )}
      </Section>

      {/* (23/09, 2e passe — Christophe : « par immat ce serait pas malin ») LES LIMITES
          APPARTIENNENT AU TYPE, pas à l'immatriculation : un club avec trois VL3 ne saisit
          rien trois fois. Elles se lisent ici, se modifient dans l'onglet Types. */}
      <Section title="G ALERT THRESHOLDS">
        <div style={full}>
          <TypeLimitsReadOut code={form.typeDesig} types={types} />
        </div>
      </Section>

      <Section title="PHOTO">
        <AircraftPhotoField form={form} setForm={setForm} />
      </Section>
    </div>
  )
}

// (23/09) Limites du TYPE, en lecture seule dans la fiche avion. Elles ne se modifient que
// dans l'onglet Types : les changer ici donnerait l'illusion d'un réglage par immatriculation.
function TypeLimitsReadOut({ code, types }) {
  const L = code ? types[code] : null
  const num = v => (v == null || v === '' ? '—' : String(v))
  if (!code) return <Hint>Set the type designator above to see its structural limits.</Hint>
  if (!L) return (
    <div style={{ ...fieldBase, padding: 10, background: T.paper }}>
      <div style={{ ...monoStyle(13, T.ink), fontWeight: 500 }}>{code}</div>
      <Hint>Nothing recorded for this type yet. Set it once, in the Types tab — it then applies
        to every {code} of the club.</Hint>
    </div>
  )
  return (
    <div style={{ ...fieldBase, padding: 10, background: T.paper }}>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        {[['G ALERT +', num(L.gPos), 'g'], ['G ALERT −', num(L.gNeg), 'g'],
          ['VNE', num(L.vne), 'kt'], ['VNO', num(L.vno), 'kt'], ['VA', num(L.va), 'kt']].map(([l, v, u]) => (
          <div key={l}>
            <div style={labelStyle(T.etch)}>{l} {u.toUpperCase()}</div>
            <div style={{ ...monoStyle(15, T.ink), fontWeight: 500, marginTop: 2 }}>{v}</div>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
        <StatusDot tone={L.confirmed ? 'ok' : 'caution'} />
        <span style={{ fontFamily: T.sans, fontSize: 12, color: T.graphite }}>
          {L.confirmed ? 'Confirmed — flights of this type are checked against these thresholds.'
                       : 'To confirm — nothing is checked until these thresholds are confirmed.'}
        </span>
      </div>
      {L.source && <Hint>{L.source}</Hint>}
    </div>
  )
}

// ─── Row pieces ───────────────────────────────────────────────────────────────
function AircraftThumb({ ac }) { return <AircraftPhoto ac={ac} width={56} height={36} /> }   // (21/09) composant partagé

// Liste d'actions de fin de ligne.
const Actions = ({ children }) => (
  <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap' }}>{children}</div>
)


// ─── Main AdminPage ───────────────────────────────────────────────────────────
export default function AdminPage() {
  // Le club courant vient du ClubContext (sélectionné via SelectClubPage pour
  // super_admin, ou imposé par users/{uid}.clubId pour admin de club).
  const { clubId, club } = useClub()

  const [tab,      setTab]      = useState('PILOTS')
  const [pilots,   setPilots]   = useState([])
  const [aircraft, setAircraft] = useState([])
  // (23/09) LIMITES PAR TYPE — collection `aircraftTypes`, clé = désignateur OACI (VL3, FK9,
  // SV4, MCR1…). Volontairement GLOBALE, pas par club : les limites d'un VL3 ne dépendent pas
  // de qui l'exploite. Saisies une fois, elles valent pour tous les appareils de ce type.
  const [types, setTypes] = useState({})
  const [typeForm, setTypeForm] = useState(null)
  const [invites,  setInvites]  = useState([])   // (accès) invitations en attente/acceptées
  const [members,  setMembers]  = useState([])   // (accès) users rattachés à ce club
  const [loading,  setLoading]  = useState(true)
  const [refs,     setRefs]     = useState({ pilot: {}, ac: {} })   // (22/09) vols non archivés citant chaque fiche (purge)

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
      getDocs(query(collection(db, 'flights'), where('clubId', '==', clubId))),
    ]).then(([ps, as, iv, us, fs]) => {
      const pr = {}, ar = {}
      fs.docs.forEach(d => { const f = d.data(); if (f.archived) return
        if (f.pilotId) pr[f.pilotId] = (pr[f.pilotId] || 0) + 1
        if (f.instructorId) pr[f.instructorId] = (pr[f.instructorId] || 0) + 1
        if (f.aircraftIdent) ar[f.aircraftIdent] = (ar[f.aircraftIdent] || 0) + 1 })
      setRefs({ pilot: pr, ac: ar })
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

  // Limites par type — collection globale, chargée indépendamment du club.
  useEffect(() => {
    getDocs(collection(db, 'aircraftTypes'))
      .then(sn => { const m = {}; sn.docs.forEach(d => { m[d.id] = { code: d.id, ...d.data() } }); setTypes(m) })
      .catch(e => console.error('[AdminPage] aircraftTypes:', e))
  }, [])

  const saveTypeLimits = async () => {
    const f = typeForm
    if (!f?.code) return setError('Type designator required')
    setSaving(true); setError('')
    const num = v => (v === '' || v == null ? null : Number(v))
    const data = {
      gPos: num(f.gPos), gNeg: num(f.gNeg), vne: num(f.vne), vno: num(f.vno), va: num(f.va),
      source: f.source || '', confirmed: !!f.confirmed,
      manufacturer: f.manufacturer || '', model: f.model || '',
      updatedAt: serverTimestamp(),
    }
    try {
      await setDoc(doc(db, 'aircraftTypes', f.code), data, { merge: true })
      setTypes(prev => ({ ...prev, [f.code]: { ...prev[f.code], ...data, code: f.code } }))
      setTypeForm(null)
      setNotice('ok', `Limits saved for ${f.code} — they apply to every ${f.code} of the club.`)
    } catch (e) { setError(e.message) } finally { setSaving(false) }
  }
  // (23/09) Pré-remplissage NATUREL : choisir un désignateur remplit le modèle depuis la base
  // OACI, et pose les seuils d'alerte par défaut à ± 2 g (demande Christophe : ce sont des
  // seuils de SURVEILLANCE, pas les limites structurelles de la cellule).
  const G_DEFAULT_POS = '2', G_DEFAULT_NEG = '-2'
  const typeDefaults = (code) => {
    const L = types[code] || {}
    const meta = findAircraftType(code)
    const str = v => (v == null || v === '' ? '' : String(v))
    const known = !!types[code]
    return {
      code,
      manufacturer: L.manufacturer || '',
      model:        L.model || meta?.name || '',
      gPos: known ? str(L.gPos) : G_DEFAULT_POS,
      gNeg: known ? str(L.gNeg) : G_DEFAULT_NEG,
      vne: str(L.vne), vno: str(L.vno), va: str(L.va),
      source: L.source || '', confirmed: !!L.confirmed,
    }
  }
  const openTypeForm = (code) => { setTypeForm({ ...typeDefaults(code), isNew: false }); setError('') }
  const openNewType  = () => { setTypeForm({ ...typeDefaults(''), isNew: true }); setError('') }

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
  // Types RÉELLEMENT présents dans la flotte : la base OACI en compte 205, les afficher tous
  // serait du bruit. On saisit les limites des types qu'on exploite.
  // Types de la flotte + types déjà fichés (on peut ficher un type avant d'avoir l'avion).
  const fleetTypes = [...new Set([
    ...aircraft.filter(a => !a.archived).map(a => a.typeDesig).filter(Boolean),
    ...Object.keys(types),
  ])].sort(compareText)
  const typesConfirmed = fleetTypes.filter(t => types[t]?.confirmed).length

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
    setPilots(prev => prev.map(x => x.id === p.id ? { ...x, archived: true } : x))   // (21/09) gardé grisé + Restore (comme les avions)
  }
  const restorePilot = async (p) => {
    await updateDoc(doc(db, 'pilots', p.id), { archived: false, updatedAt: serverTimestamp() })
    setPilots(prev => prev.map(x => x.id === p.id ? { ...x, archived: false } : x))
  }

  // ── (21/09) PURGE = suppression DÉFINITIVE d'une fiche ARCHIVÉE (Restore reste le filet avant purge).
  // Garde-fou historique : une fiche encore citée par des vols non archivés du club n'est PAS purgée
  // (le carnet perdrait le nom du pilote / l'avion) → message clair, la fiche reste archivée.
  const [purgeMsg, setPurgeMsg] = useState(null)   // { tone, text }
  const flightsCiting = async (field, value) => {
    if (!value) return 0
    const snap = await getDocs(query(collection(db, 'flights'), where('clubId', '==', clubId), where(field, '==', value)))
    return snap.docs.filter(d => d.data().archived !== true).length
  }
  const purgePilotDoc = async (p) => {
    const n = (await flightsCiting('pilotId', p.id)) + (await flightsCiting('instructorId', p.id))
    if (n > 0) return { ok: false, why: `${p.firstName || ''} ${p.lastName || ''}`.trim() + ` is on ${n} flight${n > 1 ? 's' : ''}` }
    await deleteDoc(doc(db, 'pilots', p.id))
    return { ok: true }
  }
  const purgeAircraftDoc = async (a) => {
    const ids = [...new Set([a.registration, a.callSign].filter(Boolean))]
    let n = 0; for (const v of ids) n += await flightsCiting('aircraftIdent', v)
    if (n > 0) return { ok: false, why: `${a.callSign || a.registration} has ${n} flight${n > 1 ? 's' : ''}` }
    if (a.photoStoragePath) { try { await deleteObject(storageRef(storage, a.photoStoragePath)) } catch (e) { console.warn('[Admin] photo purge:', e?.message || e) } }
    await deleteDoc(doc(db, 'aircraft', a.id))
    return { ok: true }
  }
  const runPurge = async (items, fn, setList, noun) => {
    setPurgeMsg(null); setSaving(true)
    const kept = []; let done = 0
    try {
      for (const it of items) {
        const r = await fn(it)
        if (r.ok) { done++; setList(prev => prev.filter(x => x.id !== it.id)) } else kept.push(r.why)
      }
      const head = `${done} archived ${noun}${done === 1 ? '' : 's'} purged.`
      setPurgeMsg(kept.length
        ? { tone: 'caution', text: `${head} Kept to preserve the logbook: ${kept.join(' · ')}.` }
        : { tone: 'ok', text: head })
    } catch (e) {
      setPurgeMsg({ tone: 'caution', text: `Purge stopped: ${e?.message || e}` })
    } finally { setSaving(false) }
  }

  // ── Aircraft CRUD ───────────────────────────────────────────────────────────
  const openNewAircraft  = () => { setEditId(null); setAircraftForm({ ...EMPTY_AIRCRAFT }); setError('') }
  const openEditAircraft = (a) => { setEditId(a.id); setAircraftForm({ ...EMPTY_AIRCRAFT, ...a, ownerPilotIds: ownerIdsOf(a) }); setError('') }

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
        // (24/09) La LISTE fait foi ; ownerPilotId garde le premier nom tant que le reste du
        // dashboard le lit. Avion club : les deux sont vidés, sinon un ancien propriétaire
        // continuerait de se voir créditer des vols.
        ownerPilotIds:    aircraftForm.ownership === 'owner' ? ownerIdsOf(aircraftForm) : [],
        ownerPilotId:     aircraftForm.ownership === 'owner' ? (ownerIdsOf(aircraftForm)[0] || '') : '',
        photoUrl:         aircraftForm.photoUrl || '',
        photoStoragePath: aircraftForm.photoStoragePath || '',
        photoCredit:      aircraftForm.photoCredit || '',
        photoLink:        aircraftForm.photoLink   || '',
        photoSource:      aircraftForm.photoSource || '',
        photoZoom:        Number(aircraftForm.photoZoom) || 1,
        photoX:           Number(aircraftForm.photoX ?? 50),
        photoY:           Number(aircraftForm.photoY ?? 50),
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
  const switchTab = (k) => { setTab(k); setPilotForm(null); setAircraftForm(null); setPurgeMsg(null) }
  const [qPilots, setQPilots] = useState(''), [qAircraft, setQAircraft] = useState(''), [qAccess, setQAccess] = useState('')

  const pendingInvites = invites.filter(i => i.status !== 'accepted')
  const pilotName = (id) => { const p = pilots.find(x => x.id === id); return p ? `${p.firstName || ''} ${p.lastName || ''} ${p.trigram || ''}` : '' }
  const pilotsShown   = [...pilots].sort((x, y) => (x.archived ? 1 : 0) - (y.archived ? 1 : 0)).filter(p => matches(qPilots, p.archived ? 'archived' : '', p.firstName, p.lastName, p.trigram, p.email, p.accountEmail, p.licence, p.isInstructor ? 'fi instructor' : '', ...(p.licences || [])))
  const aircraftShown = [...aircraft].sort((x, y) => (x.archived ? 1 : 0) - (y.archived ? 1 : 0))
    .filter(a => matches(qAircraft, a.callSign, a.registration, a.typeDesig, a.type, a.icao24, a.homeBase, a.ownership === 'owner' ? `owner ${ownerIdsOf(a).map(pilotName).join(' ')}` : 'club', a.archived ? 'archived' : ''))
  const membersShown  = members.filter(m => matches(qAccess, m.email, m.displayName, m.role))
  const invitesShown  = pendingInvites.filter(i => matches(qAccess, i.email, i.id, i.role))

  // ── (22/09) Admin d'après Claude Design « Admin dashboard live build » ─────────────────────────────────────
  // Métriques par onglet (ce qui manque), recherche toujours visible « n OF total », fiches actives et ARCHIVÉES
  // séparées (bannière archive ≠ purge, « REFERRED TO BY n FLIGHTS »), tiroirs avec code d'invitation et bascules.
  const MISSING = '−−−'
  const lab = labelStyle(T.etch)
  const pName = (p) => `${p.firstName || ''} ${p.lastName || ''}`.trim() || MISSING
  const pRefs = (p) => refs.pilot[p.id] || 0
  const aRefs = (a) => [...new Set([a.callSign, a.registration].filter(Boolean))].reduce((n, k) => n + (refs.ac[k] || 0), 0)
  const activePilots = pilots.filter(p => !p.archived), archPilots = pilots.filter(p => p.archived)
  const activeAc = aircraft.filter(a => !a.archived), archAc = aircraft.filter(a => a.archived)
  const pilotsList = activePilots.filter(p => pilotsShown.includes(p))
  const acList = activeAc.filter(a => aircraftShown.includes(a))
  const unlinked = activePilots.filter(p => !p.uid).length
  const dupPins = activePilots.filter(p => p.pinConflict).length
  const fiCount = activePilots.filter(p => p.isInstructor).length
  const noHex = activeAc.filter(a => !a.icao24).length
  const noPhoto = activeAc.filter(a => !a.photoUrl).length
  const noAccess = activePilots.filter(p => !p.uid && !members.some(m => (m.email || '').toLowerCase() === (p.email || '').toLowerCase())).length
  const typePicks = [...new Set(activeAc.map(a => a.typeDesig).filter(Boolean))].sort(compareText).slice(0, 6)
  const setNotice = (tone, text) => setPurgeMsg({ tone, text })

  const openBtn = (onClick) => <Button size="sm" icon="edit" onClick={onClick}>Open</Button>
  const pilotColumns = [
    { key: 'trigram', label: 'TRIG', mono: true, width: 62, render: p => <span style={{ ...monoStyle(13), fontWeight: 500, letterSpacing: '0.08em' }}>{p.trigram || MISSING}</span> },
    { key: 'name', label: 'PILOT', render: p => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{pName(p)}</span>
        <span style={{ fontSize: 11, color: T.graphite, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.email || '—'}</span>
      </div>
    ) },
    { key: 'qual', label: 'QUALIFICATION', render: p => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <Chip>{p.licence === 'student' ? 'STUDENT' : 'LICENSED'}</Chip>
          {p.isInstructor && <Chip strong title="Flight instructor">FI</Chip>}
        </div>
        {p.licences?.length > 0 && <span style={{ ...lab, whiteSpace: 'nowrap' }}>{p.licences.map(l => l.toUpperCase()).join(' · ')}</span>}
      </div>
    ) },
    { key: 'role', label: 'ROLE', render: p => <span style={{ fontSize: 13 }}>{roleLabel(p.role)}</span> },
    { key: 'pin', label: 'PIN', mono: true, render: p => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <span style={monoStyle(13, p.pin ? T.ink : T.etch)}>{p.pin ? '••••' : MISSING}</span>
        {p.pinConflict && <span title="Another pilot of the club has the same PIN: change one so the AKview tells them apart."><StatusDot tone="caution" text="DUPLICATE" /></span>}
      </div>
    ) },
    { key: 'account', label: 'STATUS', render: p => (
      <span title={p.uid ? `Linked account: ${p.accountEmail || 'yes'}` : 'No dashboard sign-in linked yet: generate an invitation code'}>
        <StatusDot tone={p.uid ? 'ok' : 'caution'} text={p.uid ? 'LINKED' : 'NOT LINKED'} />
      </span>
    ) },
    { key: 'actions', label: '', align: 'right', render: p => (
      <Actions>
        {openBtn(() => openEditPilot(p))}
        <Button size="sm" variant="ghost" icon="archive" confirm="Archive?" title="Archive: reversible, flights kept"
          onClick={() => { deletePilot(p); setNotice('info', `${pName(p)} archived. The record leaves the lists and totals; every flight already flown stays readable. Restore it at any time below.`) }}>Archive</Button>
      </Actions>
    ) },
  ]
  const archivedCols = (kind) => [
    kind === 'pilot'
      ? { key: 'trig', label: 'TRIG', mono: true, width: 62, render: p => <span style={monoStyle(13, T.etch)}>{p.trigram || MISSING}</span> }
      : { key: 'photo', label: '', width: 72, render: a => <AircraftThumb ac={a} /> },
    { key: 'name', label: kind === 'pilot' ? 'PILOT' : 'AIRCRAFT', render: r => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: T.etch }}>
        <span style={kind === 'pilot' ? { fontSize: 13 } : monoStyle(14, T.etch)}>{kind === 'pilot' ? pName(r) : (r.callSign || r.registration)}</span>
        {kind !== 'pilot' && <span style={monoStyle(12, T.etch)}>{r.typeDesig || ''}</span>}
        <Chip muted>ARCHIVED</Chip>
      </div>
    ) },
    { key: 'ref', label: 'REFERRED TO BY', render: r => { const n = kind === 'pilot' ? pRefs(r) : aRefs(r); return <span style={lab}>{n ? `${n} FLIGHT${n === 1 ? '' : 'S'} · KEPT ON PURGE` : 'NO FLIGHT · CAN BE PURGED'}</span> } },
    { key: 'act', label: '', align: 'right', render: r => (
      <Actions>
        <Button size="sm" icon="refresh" onClick={() => { (kind === 'pilot' ? restorePilot : restoreAircraft)(r); setNotice('ok', `${kind === 'pilot' ? pName(r) : (r.callSign || r.registration)} restored: back in the lists and totals.`) }}>Restore</Button>
        <Button size="sm" variant="danger" icon="close" confirm="Delete for ever?" title="Purge: permanent"
          onClick={() => (kind === 'pilot' ? runPurge([r], purgePilotDoc, setPilots, 'pilot') : runPurge([r], purgeAircraftDoc, setAircraft, 'aircraft'))}>Purge</Button>
      </Actions>
    ) },
  ]
  const aircraftColumns = [
    { key: 'photo', label: '', width: 72, render: a => <AircraftThumb ac={a} /> },
    { key: 'callSign', label: 'CALL SIGN', render: a => <span style={{ ...monoStyle(14), fontWeight: 500 }}>{a.callSign || a.registration}</span> },
    { key: 'typeDesig', label: 'TYPE', mono: true, render: a => a.typeDesig || MISSING },
    { key: 'icao24', label: 'HEX', mono: true, render: a => <span style={{ color: a.icao24 ? T.ink : T.etch }}>{a.icao24 ? a.icao24.toUpperCase() : MISSING}</span> },
    { key: 'homeBase', label: 'BASE', mono: true, render: a => a.homeBase || MISSING },
    { key: 'ownership', label: 'OWNERSHIP', render: a => {
      const isOwner = a.ownership === 'owner'
      const ids = isOwner ? ownerIdsOf(a) : []
      const names = ids.map(id => { const p = pilots.find(x => x.id === id); return p ? pName(p) : null }).filter(Boolean)
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Chip strong={isOwner}>{!isOwner ? 'CLUB' : ids.length > 1 ? 'SHARED' : 'OWNER'}</Chip>
          {isOwner && <span style={{ fontSize: 13 }}>{names.length ? names.join(' + ') : MISSING}</span>}
        </div>
      )
    } },
    { key: 'status', label: 'STATUS', render: a => (!a.icao24 ? <StatusDot tone="caution" text="NO HEX" /> : !a.photoUrl ? <StatusDot tone="caution" text="NO PHOTO" /> : <StatusDot tone="ok" text="COMPLETE" />) },
    { key: 'actions', label: '', align: 'right', render: a => (
      <Actions>
        {openBtn(() => openEditAircraft(a))}
        <Button size="sm" variant="ghost" icon="archive" confirm="Archive?" title="Archive: reversible, flights kept"
          onClick={() => { deleteAircraft(a); setNotice('info', `${a.callSign || a.registration} archived. It leaves the lists and the live views; its flights stay readable. Restore it at any time below.`) }}>Archive</Button>
      </Actions>
    ) },
  ]
  const memberColumns = [
    { key: 'name', label: 'MEMBER', render: m => (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{m.displayName || m.email}</span>
        <span style={{ fontSize: 11, color: T.graphite }}>{m.email}</span>
      </div>
    ) },
    { key: 'role', label: 'ROLE', width: 260, render: m => m.role === 'super_admin' ? (
      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Chip strong>SUPER ADMIN</Chip><span style={lab}>READ ONLY</span></span>
    ) : (
      <Select value={m.role || 'user'} aria-label={`Role for ${m.email}`} onChange={v => { changeMemberRole(m, v); setNotice('ok', `${m.displayName || m.email} is now ${roleLabel(v)}. The new role applies at their next page load.`) }}
        options={[{ value: 'user', label: 'Pilot · own flights' }, { value: 'instructor', label: 'Instructor · club logbook' }, { value: 'admin', label: 'Admin · full club' }]} />
    ) },
    { key: 'status', label: 'STATUS', render: () => <StatusDot tone="ok" text="SIGNED IN" /> },
    { key: 'actions', label: '', align: 'right', render: m => (m.role === 'super_admin' ? <span style={lab}>CANNOT BE REMOVED</span> : (
      <Actions>
        <Button size="sm" variant="danger" confirm="Remove access?" title={`Withdraw the dashboard sign-in of ${m.email}`}
          onClick={() => { revokeMember(m); setNotice('info', `Access removed for ${m.displayName || m.email}. The pilot record and the flights are untouched; only the dashboard sign-in is withdrawn.`) }}>Remove access</Button>
      </Actions>
    )) },
  ]
  const inviteColumns = [
    { key: 'email', label: 'E-MAIL', render: i => <span style={{ fontSize: 13 }}>{i.email}</span> },
    { key: 'role', label: 'INVITED AS', render: i => <span style={{ fontSize: 13 }}>{roleLabel(i.role || 'user')}</span> },
    { key: 'status', label: 'STATUS', render: () => <StatusDot tone="caution" text="WAITING FOR FIRST SIGN-IN" /> },
    { key: 'actions', label: '', align: 'right', render: inv => (
      <Actions><Button size="sm" variant="ghost" confirm="Cancel it?" onClick={() => { revokeInvite(inv); setNotice('info', `Invitation cancelled: ${inv.email} can no longer join with it.`) }}>Cancel</Button></Actions>
    ) },
  ]

  const pilotIsEdit = !!editId && !!pilotForm
  const pilotConflict = trigramConflictOf(pilotForm, allTrigrams, pilotIsEdit)
  const metrics = (cards) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
      {cards.map(c => <MetricCard key={c.label} label={c.label} value={loading ? null : String(c.value)} status={loading ? undefined : c.status} />)}
    </div>
  )
  const toolbar = (q, setQ, placeholder, shown, total, right) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 320px', maxWidth: 420 }}><SearchBox value={q} onChange={setQ} placeholder={placeholder} count={shown} total={total} /></div>
      <span style={lab}>{shown} OF {total}</span>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>{right}</div>
    </div>
  )
  const archivedBlock = (kind, list) => list.length > 0 && (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, paddingBottom: 8, borderBottom: T.border }}>
        <h2 style={{ ...headingStyle(15), margin: 0 }}>Archived {kind === 'pilot' ? 'pilots' : 'aircraft'}</h2>
        <span style={lab}>{list.length} ARCHIVED · {list.filter(r => !(kind === 'pilot' ? pRefs(r) : aRefs(r))).length} CAN BE PURGED</span>
      </div>
      <Banner tone="info" title="Archive keeps the logbook intact">
        An archived {kind === 'pilot' ? 'pilot' : 'aircraft'} leaves the lists and the totals; every flight already flown stays readable. Purge deletes the record for good and is refused while a flight still refers to it.
      </Banner>
      <DataTable columns={archivedCols(kind)} rows={list} />
    </div>
  )

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={{ width: '100%', maxWidth: '100%', overflowX: 'hidden', height: '100%', background: T.paper, fontFamily: T.sans, color: T.ink, overflowY: 'auto' }}>
      <main style={{ padding: 'clamp(14px, 3.5vw, 28px) clamp(12px, 4vw, 32px) 48px', display: 'flex', flexDirection: 'column', gap: 18, maxWidth: 1320 }}>
        <header style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={lab}>{[club?.name, club?.icao].filter(Boolean).join(' · ').toUpperCase() || 'CLUB RECORDS'}</span>
          <h1 style={{ ...headingStyle(28), margin: 0 }}>Admin</h1>
        </header>
        <Tabs ariaLabel="Admin sections" value={tab} onChange={switchTab} tabs={[
          { key: 'PILOTS', label: 'Pilots', count: activePilots.length },
          { key: 'AIRCRAFT', label: 'Aircraft', count: activeAc.length },
          { key: 'TYPES', label: 'Types', count: fleetTypes.length },
          { key: 'ACCESS', label: 'Access', count: members.length },
        ]} />

        {purgeMsg && (
          <Banner tone={purgeMsg.tone} action={<Button size="sm" variant="ghost" icon="close" onClick={() => setPurgeMsg(null)}>Dismiss</Button>}>{purgeMsg.text}</Banner>
        )}
        {error && !pilotForm && !aircraftForm && (
          <Banner tone="caution" action={<Button size="sm" variant="ghost" onClick={() => setError('')}>Dismiss</Button>}>{error}</Banner>
        )}

        {tab === 'PILOTS' && (<>
          {metrics([
            { label: 'PILOTS ON FILE', value: activePilots.length, status: { tone: 'off', text: `${fiCount} instructor${fiCount === 1 ? '' : 's'} · ${activePilots.length - fiCount} pilots` } },
            { label: 'ACCOUNT NOT LINKED', value: unlinked, status: unlinked ? { tone: 'caution', text: 'Send an invitation code' } : { tone: 'ok', text: 'Every pilot linked' } },
            { label: 'DUPLICATE PIN', value: dupPins, status: dupPins ? { tone: 'caution', text: 'Change one so the AKview tells them apart' } : { tone: 'ok', text: 'All PINs unique' } },
          ])}
          {toolbar(qPilots, setQPilots, 'Name, trigram, e-mail or licence · Esc clears', pilotsList.length, activePilots.length, <>
            {archPilots.length > 0 && (
              <Button size="sm" variant="ghost" icon="archive" confirm="Purge all archived?" disabled={saving}
                onClick={() => runPurge(archPilots, purgePilotDoc, setPilots, 'pilot')}>Purge archived ({archPilots.length})</Button>
            )}
            <Button size="sm" variant="primary" icon="user" onClick={openNewPilot}>New pilot</Button>
          </>)}
          <DataTable columns={pilotColumns} rows={pilotsList} loading={loading}
            empty={qPilots.trim()
              ? <EmptyState text={`No pilot matches “${qPilots.trim()}”.`} actionLabel="Clear the search" onAction={() => setQPilots('')} />
              : <EmptyState text="No pilots yet." actionLabel="New pilot" onAction={openNewPilot} />} />
          {archivedBlock('pilot', archPilots.filter(p => pilotsShown.includes(p)))}
        </>)}

        {tab === 'AIRCRAFT' && (<>
          {metrics([
            { label: 'AIRCRAFT ON FILE', value: activeAc.length, status: { tone: 'off', text: `${activeAc.filter(a => a.ownership !== 'owner').length} club · ${activeAc.filter(a => a.ownership === 'owner').length} owners` } },
            { label: 'NO HEX (MODE S)', value: noHex, status: noHex ? { tone: 'caution', text: 'Not identified on the live map' } : { tone: 'ok', text: 'Every aircraft identified' } },
            { label: 'NO PHOTO', value: noPhoto, status: noPhoto ? { tone: 'caution', text: 'Harder to recognise' } : { tone: 'ok', text: 'All photos in place' } },
          ])}
          {toolbar(qAircraft, setQAircraft, 'Registration, type, hex, base or owner · Esc clears', acList.length, activeAc.length, <>
            {archAc.length > 0 && (
              <Button size="sm" variant="ghost" icon="archive" confirm="Purge all archived?" disabled={saving}
                onClick={() => runPurge(archAc, purgeAircraftDoc, setAircraft, 'aircraft')}>Purge archived ({archAc.length})</Button>
            )}
            <Button size="sm" variant="primary" icon="plane" onClick={openNewAircraft}>New aircraft</Button>
          </>)}
          <DataTable columns={aircraftColumns} rows={acList} loading={loading}
            empty={qAircraft.trim()
              ? <EmptyState text={`No aircraft matches “${qAircraft.trim()}”.`} actionLabel="Clear the search" onAction={() => setQAircraft('')} />
              : <EmptyState text="No aircraft yet." actionLabel="New aircraft" onAction={openNewAircraft} />} />
          {archivedBlock('aircraft', archAc.filter(a => aircraftShown.includes(a)))}
        </>)}

        {tab === 'TYPES' && (<>
          {metrics([
            { label: 'TYPES IN THE FLEET', value: fleetTypes.length,
              status: { tone: 'off', text: 'Thresholds are shared by every aircraft of a type' } },
            { label: 'THRESHOLDS CONFIRMED', value: typesConfirmed,
              status: typesConfirmed === fleetTypes.length && fleetTypes.length
                ? { tone: 'ok', text: 'Load factors checked on every flight' }
                : { tone: 'caution', text: 'Unconfirmed thresholds raise no alert' } },
            { label: 'NOT SET YET', value: fleetTypes.filter(t => !types[t]).length,
              status: { tone: 'off', text: 'Nothing recorded for these types' } },
          ])}
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
            <Button size="sm" variant="primary" icon="plus" onClick={openNewType}>New type</Button>
          </div>
          <DataTable loading={loading} rows={fleetTypes.map(code => ({ id: code, code }))}
            columns={[
              { key: 'code', label: 'TYPE', render: r => (
                <div>
                  <div style={{ ...monoStyle(15, T.ink), fontWeight: 500 }}>{r.code}</div>
                  <div style={{ fontFamily: T.sans, fontSize: 12, color: T.graphite }}>{findAircraftType(r.code)?.name || '—'}</div>
                </div>) },
              { key: 'fleet', label: 'IN THE FLEET', render: r => (
                <span style={monoStyle(13, T.graphite)}>{activeAc.filter(a => a.typeDesig === r.code).map(a => a.callSign || a.registration).join(' · ') || '—'}</span>) },
              { key: 'g', label: 'G ALERT + / −', render: r => {
                const L = types[r.code]
                return <span style={monoStyle(14, T.ink)}>{L && (L.gPos != null || L.gNeg != null)
                  ? `${L.gPos ?? '—'} / ${L.gNeg ?? '—'} g` : '—'}</span> } },
              { key: 'v', label: 'VNE', render: r => <span style={monoStyle(14, T.ink)}>{types[r.code]?.vne != null ? `${types[r.code].vne} kt` : '—'}</span> },
              { key: 'st', label: 'STATUS', render: r => {
                const L = types[r.code]
                if (!L || (L.gPos == null && L.gNeg == null)) return <StatusDot tone="off" label="NOT SET" />
                return L.confirmed ? <StatusDot tone="ok" label="CONFIRMED" /> : <StatusDot tone="caution" label="TO CONFIRM" /> } },
              { key: 'act', label: '', render: r => (
                <Actions><Button size="sm" variant="ghost" icon="edit" onClick={() => openTypeForm(r.code)}>Open</Button></Actions>) },
            ]}
            empty={<EmptyState text="No aircraft type in the fleet yet — add an aircraft first." />} />
        </>)}

        {tab === 'ACCESS' && (<>
          {metrics([
            { label: 'DASHBOARD MEMBERS', value: members.length, status: { tone: 'off', text: `${members.filter(m => m.role === 'admin' || m.role === 'super_admin').length} admin · ${members.filter(m => m.role === 'instructor').length} instructor` } },
            { label: 'PENDING INVITATIONS', value: pendingInvites.length, status: pendingInvites.length ? { tone: 'caution', text: 'Waiting for first sign-in' } : { tone: 'ok', text: 'Nothing waiting' } },
            { label: 'PILOTS WITHOUT ACCESS', value: noAccess, status: { tone: 'off', text: 'They fly, they do not sign in' } },
          ])}
          {toolbar(qAccess, setQAccess, 'Name, e-mail or role · Esc clears', membersShown.length, members.length,
            <Button size="sm" variant="primary" icon="user" onClick={() => { setInviteForm(f => f || { email: '', role: 'user' }); setTimeout(() => document.getElementById('invite-email')?.focus(), 0) }}>New invitation</Button>)}
          <DataTable columns={memberColumns} rows={membersShown} loading={loading}
            empty={<EmptyState text={qAccess.trim() ? `No member matches “${qAccess.trim()}”.` : 'No one has access to this club yet.'} />} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16, alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, paddingBottom: 8, borderBottom: T.border }}>
                <h2 style={{ ...headingStyle(15), margin: 0 }}>Pending invitations</h2>
                <span style={lab}>{invitesShown.length} WAITING</span>
              </div>
              <DataTable columns={inviteColumns} rows={invitesShown} empty={<EmptyState text="No invitation waiting." />} />
              <span style={lab}>AN INVITATION BY E-MAIL NEEDS A GOOGLE ACCOUNT · AN INVITATION CODE WORKS WITH ANY SIGN-IN</span>
            </div>
            <div style={{ background: T.card, border: T.border, borderRadius: T.radius.md, padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <h2 style={{ ...headingStyle(15), margin: 0 }}>Invite someone</h2>
                <span style={{ fontSize: 12, color: T.graphite }}>They sign in with this Google account and get access to {club?.name || 'this club'} automatically.</span>
              </div>
              <Field label="E-MAIL (GOOGLE ACCOUNT)" hint="A pilot without a Google account links with an invitation code instead (Pilots tab).">
                <Input id="invite-email" type="email" value={inviteForm?.email || ''} placeholder="name@example.com"
                  onChange={v => setInviteForm(f => ({ role: 'user', ...(f || {}), email: v }))} />
              </Field>
              <Field label="INVITED AS">
                <Select value={inviteForm?.role || 'user'} onChange={v => setInviteForm(f => ({ email: '', ...(f || {}), role: v }))}
                  options={[{ value: 'user', label: 'Pilot · own flights' }, { value: 'instructor', label: 'Instructor · club logbook' }, { value: 'admin', label: 'Admin · full club' }]} />
              </Field>
              <div><Button size="sm" variant="primary" icon="check" disabled={saving || !(inviteForm?.email || '').trim()} onClick={sendInvite}>{saving ? 'Sending…' : 'Send invitation'}</Button></div>
            </div>
          </div>
        </>)}
      </main>

      {/* Pilot drawer */}
      <Drawer closeOnOverlay={false} open={!!pilotForm} onClose={closePilotForm}
        title={pilotForm ? (editId ? (pName(pilotForm) || 'Edit pilot') : 'New pilot') : ''}
        subtitle={pilotForm ? [pilotForm.trigram, pilotForm.licence === 'student' ? 'STUDENT' : 'LICENSED', editId ? `${pRefs({ id: editId })} flights on file` : club?.code].filter(Boolean).join(' · ') : undefined}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            {editId ? (
              <Button size="sm" variant="danger" icon="archive" confirm="Archive?" title="Reversible: the flights stay"
                onClick={() => { const p = pilots.find(x => x.id === editId); if (p) { deletePilot(p); setNotice('info', `${pName(p)} archived. Every flight already flown stays readable; restore it at any time.`) } closePilotForm() }}>Archive pilot</Button>
            ) : <span />}
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" onClick={closePilotForm}>Cancel</Button>
              <Button size="sm" variant="primary" icon="check" onClick={savePilot} disabled={saving || pilotConflict}>{saving ? 'Saving…' : 'Save'}</Button>
            </div>
          </div>
        }>
        {pilotForm && (
          <PilotForm form={pilotForm} setForm={setPilotForm} allTrigrams={allTrigrams} currentClub={club} error={error}
            isEdit={!!editId} pilot={editId ? pilots.find(x => x.id === editId) : null} />
        )}
      </Drawer>

      {/* Aircraft drawer */}
      <Drawer closeOnOverlay={false} open={!!aircraftForm} onClose={closeAircraftForm}
        title={aircraftForm ? (aircraftForm.callSign || (editId ? 'Edit aircraft' : 'New aircraft')) : ''}
        subtitle={aircraftForm ? [aircraftForm.typeDesig, aircraftForm.homeBase, aircraftForm.ownership === 'owner' ? (ownerIdsOf(aircraftForm).length > 1 ? 'shared ownership' : 'private owner') : 'club aircraft'].filter(Boolean).join(' · ') : undefined}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            {editId ? (
              <Button size="sm" variant="danger" icon="archive" confirm="Archive?" title="Reversible: the flights stay"
                onClick={() => { const a = aircraft.find(x => x.id === editId); if (a) { deleteAircraft(a); setNotice('info', `${a.callSign || a.registration} archived. Its flights stay readable; restore it at any time.`) } closeAircraftForm() }}>Archive aircraft</Button>
            ) : <span />}
            <div style={{ display: 'flex', gap: 8 }}>
              <Button size="sm" onClick={closeAircraftForm}>Cancel</Button>
              <Button size="sm" variant="primary" icon="check" onClick={saveAircraft} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            </div>
          </div>
        }>
        {aircraftForm && (
          <AircraftForm form={aircraftForm} setForm={setAircraftForm} pilots={pilots} error={error} typePicks={typePicks} types={types} />
        )}
      </Drawer>

      {/* (23/09) Tiroir des LIMITES PAR TYPE. Un seul écran de saisie pour tout le parc d'un
          type : modifier ici vaut pour chaque appareil de ce type. */}
      <Drawer open={!!typeForm} onClose={() => setTypeForm(null)}
        title={typeForm ? `${typeForm.code || 'New type'} — G alert thresholds` : ''}
        subtitle={typeForm ? (findAircraftType(typeForm.code)?.name || undefined) : undefined}
        footer={typeForm ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setTypeForm(null)}>Cancel</Button>
            <Button size="sm" variant="primary" icon="check" onClick={saveTypeLimits} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </>
        ) : undefined}>
        {typeForm && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {error && <div style={{ gridColumn: '1 / -1' }}><Banner tone="caution">{error}</Banner></div>}
            <div style={{ gridColumn: '1 / -1' }}>
              <Banner tone="info">These thresholds apply to <b>every {typeForm.code || 'aircraft of this type'}</b>.
                They are WATCH thresholds — the load factor above which a flight is worth a look —
                not the airframe\u2019s structural limits.</Banner>
            </div>
            {typeForm.isNew && (
              <div style={{ gridColumn: '1 / -1' }}>
                <Label>TYPE DESIGNATOR</Label>
                <Select
                  value={typeForm.code}
                  onChange={v => setTypeForm(p => ({ ...p, ...typeDefaults(v), isNew: true }))}
                  options={[{ value: '', label: 'Select an ICAO designator…' },
                    ...[...AIRCRAFT_TYPES].sort((a, b) => compareText(a.code, b.code))
                      .map(t => ({ value: t.code, label: `${t.code} — ${t.name}` }))]}
                />
                <Hint>The designator is the key: picking it fills the model, and the thresholds
                  start at ± 2 g. One record per type, shared by every aircraft of that type.</Hint>
              </div>
            )}
            <div>
              <Label>MANUFACTURER</Label>
              <Input value={typeForm.manufacturer} onChange={v => setTypeForm(p => ({ ...p, manufacturer: v }))} placeholder="e.g. JMB Aircraft" />
            </div>
            <div>
              <Label>MODEL</Label>
              <Input value={typeForm.model} onChange={v => setTypeForm(p => ({ ...p, model: v }))} placeholder="e.g. VL-3 Evolution" />
            </div>
            <div>
              <Label>G ALERT + </Label>
              <Input value={typeForm.gPos} onChange={v => setTypeForm(p => ({ ...p, gPos: v, confirmed: false }))} placeholder="e.g. 4" />
            </div>
            <div>
              <Label>G ALERT − </Label>
              <Input value={typeForm.gNeg} onChange={v => setTypeForm(p => ({ ...p, gNeg: v, confirmed: false }))} placeholder="e.g. -2" />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <Hint>The only thresholds that raise an alert. Default ± 2 g — a flight going beyond is
                flagged and its points are marked on the track.</Hint>
            </div>
            <div><Label>VNE (KT)</Label><Input value={typeForm.vne} onChange={v => setTypeForm(p => ({ ...p, vne: v }))} placeholder="—" /></div>
            <div><Label>VNO (KT)</Label><Input value={typeForm.vno} onChange={v => setTypeForm(p => ({ ...p, vno: v }))} placeholder="—" /></div>
            <div><Label>VA (KT)</Label><Input value={typeForm.va} onChange={v => setTypeForm(p => ({ ...p, va: v }))} placeholder="—" /></div>
            <div style={{ gridColumn: '1 / -1' }}>
              <Hint>Speeds are kept for reference only — no alert. An AKcore has no pitot: the
                recording holds ground speed, which a tailwind alone can push past VNE.</Hint>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <Label>SOURCE</Label>
              <Input value={typeForm.source} onChange={v => setTypeForm(p => ({ ...p, source: v, confirmed: false }))}
                placeholder="Where these figures come from" />
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <Label>CONFIRMED</Label>
              <div style={{ display: 'flex', gap: 6 }}>
                <Toggle active={!typeForm.confirmed} onClick={() => setTypeForm(p => ({ ...p, confirmed: false }))}>To confirm</Toggle>
                <Toggle active={!!typeForm.confirmed} onClick={() => setTypeForm(p => ({ ...p, confirmed: true }))}>Confirmed</Toggle>
              </div>
              <Hint>{typeForm.confirmed
                ? `Flights of every ${typeForm.code} are checked against these thresholds.`
                : 'Nothing is checked until this is confirmed. Editing a limit or its source clears the confirmation.'}</Hint>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  )
}
