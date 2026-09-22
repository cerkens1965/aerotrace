import { useState, useEffect } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { collection, setDoc, updateDoc, doc, getDoc, serverTimestamp, getDocs, writeBatch } from 'firebase/firestore'
import { compareText } from '../utils/sortOptions'
import { db } from '../firebase/config'
import { useClub } from '../contexts/ClubContext'
import { AirKiLockup } from '../components/ui/AirKiMark'
import { T, labelStyle, headingStyle, monoStyle, Button, StatusDot } from '../components/ui'

// ─── SelectClubPage ───────────────────────────────────────────────────────────
// Entrée obligatoire pour super_admin sans club courant : choix d'un club
// existant OU création d'un nouveau club (création inline, pas besoin de
// repasser par AdminPage).
//
// Les non-super_admin n'ont rien à faire ici : redirect vers /live.
// (2026-09-21, lot 02 B) Restylé AirKi : fond encre, lockup, textes blanc / #9A9A94, Button onInk,
// carte « Data migration » séparée (bord 1 px ruleDark). Logique inchangée.
export default function SelectClubPage() {
  const { clubs, clubsLoaded, isSuperAdmin, setClub } = useClub()
  const navigate = useNavigate()
  const [editingId, setEditingId] = useState(null)   // null = not editing | '' = create | id = edit existing
  const [form, setForm]           = useState({ code: '', name: '', icao: '' })
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')

  // ── Backfill legacy data ─────────────────────────────────────────────────
  // Détecte deux cas :
  //  • clubId manquant (legacy avant l'ajout du champ)
  //  • clubId orphelin (pointe vers un club inexistant ou archivé)
  // Tout est listé en bloc pour permettre un backfill bulk vers un club existant.
  // (Hooks déclarés AVANT le return anticipé des non-super_admin : règle des hooks React.)
  const [legacyAircraft, setLegacyAircraft] = useState([])
  const [legacyPilots,   setLegacyPilots]   = useState([])
  const [allAircraft,    setAllAircraft]    = useState([])
  const [allPilots,      setAllPilots]      = useState([])
  const [backfillTarget, setBackfillTarget] = useState('')
  const [backfilling,    setBackfilling]    = useState(false)

  useEffect(() => {
    if (!clubsLoaded || !isSuperAdmin) return
    const validIds = new Set(clubs.filter(c => c.archived !== true).map(c => c.id))
    async function scan() {
      try {
        const [asSnap, psSnap] = await Promise.all([
          getDocs(collection(db, 'aircraft')),
          getDocs(collection(db, 'pilots')),
        ])
        const aircraftAll = asSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        const pilotsAll   = psSnap.docs.map(d => ({ id: d.id, ...d.data() }))
        setAllAircraft(aircraftAll)
        setAllPilots(pilotsAll)
        setLegacyAircraft(aircraftAll.filter(a => !a.clubId || !validIds.has(a.clubId)))
        setLegacyPilots  (pilotsAll  .filter(p => !p.clubId || !validIds.has(p.clubId)))
      } catch (e) { console.error('[SelectClub] legacy scan:', e) }
    }
    scan()
  }, [clubs, clubsLoaded, isSuperAdmin])

  if (!isSuperAdmin) return <Navigate to="/live" replace />

  const isCreating = editingId === ''
  const isEditing  = editingId !== null && editingId !== ''

  const handleSelect = (id) => {
    setClub(id)
    navigate('/live')
  }

  const openCreate = () => {
    setEditingId(''); setForm({ code: '', name: '', icao: '' }); setError('')
  }
  const openEdit = (c) => {
    setEditingId(c.id)
    setForm({ code: c.code || '', name: c.name || '', icao: c.icao || '' })
    setError('')
  }
  const cancelEdit = () => {
    setEditingId(null); setForm({ code: '', name: '', icao: '' }); setError('')
  }

  const handleSave = async () => {
    if (!form.code) return setError('Code required (e.g. EBBY-01)')
    if (!form.name) return setError('Name required')
    // Code = doc id pour les nouveaux clubs → permet à AT-CORE d'écrire
    // directement clubId: "EBBY-01" sans table de mapping.
    // Sanitize : uppercase, et caractères safes pour un doc id Firestore.
    const codeUp = form.code.toUpperCase().replace(/[^A-Z0-9_-]/g, '')
    if (!codeUp) return setError('Code must contain letters, digits, dashes or underscores')
    // Conflit de code dans la liste mémoire (exclusion editingId pour le mode edit)
    if (clubs.find(c => c.id !== editingId && (c.code || '').toUpperCase() === codeUp)) {
      return setError(`Code "${form.code}" already used`)
    }
    setSaving(true); setError('')
    try {
      const data = {
        code: codeUp,
        name: form.name,
        icao: (form.icao || '').toUpperCase(),
        updatedAt: serverTimestamp(),
      }
      if (isEditing) {
        // En mode edit, on garde le doc id existant. Le code field est verrouillé
        // dans l'UI pour éviter la confusion (changement code = recréation).
        await updateDoc(doc(db, 'clubs', editingId), data)
        cancelEdit()
      } else {
        // En mode create : doc id = code. Pre-check via getDoc pour éviter
        // qu'un setDoc silencieusement écrase un club existant orphelin.
        const ref = doc(db, 'clubs', codeUp)
        const existing = await getDoc(ref)
        if (existing.exists()) {
          setError(`A club with id "${codeUp}" already exists in Firestore. Pick another code or archive the existing one first.`)
          setSaving(false); return
        }
        await setDoc(ref, { ...data, createdAt: serverTimestamp() })
        cancelEdit()
        // Auto-select le club fraîchement créé
        setClub(codeUp)
        navigate('/live')
      }
    } catch (e) { setError(e.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async (c) => {
    if (!window.confirm(`Archive club ${c.code} — ${c.name}? Pilots and aircraft linked to it stay in Firestore but become orphaned.`)) return
    try {
      await updateDoc(doc(db, 'clubs', c.id), { archived: true, updatedAt: serverTimestamp() })
    } catch (e) { window.alert(`Archive failed: ${e.message}`) }
  }

  // Backfill normal — uniquement les docs orphelins (sans clubId valide)
  const handleBackfill = async (forceAll = false) => {
    if (!backfillTarget) return
    const targetAircraft = forceAll ? allAircraft : legacyAircraft
    const targetPilots   = forceAll ? allPilots   : legacyPilots
    const total = targetAircraft.length + targetPilots.length
    if (total === 0) return
    const verb = forceAll ? 'FORCE reassign' : 'Assign'
    if (!window.confirm(`${verb} ${targetAircraft.length} aircraft + ${targetPilots.length} pilots to this club?`)) return
    setBackfilling(true)
    try {
      const batch = writeBatch(db)
      for (const a of targetAircraft) {
        batch.update(doc(db, 'aircraft', a.id), { clubId: backfillTarget, updatedAt: serverTimestamp() })
      }
      for (const p of targetPilots) {
        batch.update(doc(db, 'pilots', p.id), { clubId: backfillTarget, updatedAt: serverTimestamp() })
      }
      await batch.commit()
      setLegacyAircraft([])
      setLegacyPilots([])
      // Refresh allAircraft/allPilots avec nouveau clubId pour que "force all" ne réagit pas
      setAllAircraft(prev => prev.map(a => ({ ...a, clubId: backfillTarget })))
      setAllPilots  (prev => prev.map(p => ({ ...p, clubId: backfillTarget })))
      window.alert(`${forceAll ? 'Force reassigned' : 'Backfilled'} ${total} docs.`)
    } catch (e) { window.alert(`Backfill failed: ${e.message}`) }
    finally { setBackfilling(false) }
  }

  const orphanCount = legacyAircraft.length + legacyPilots.length
  const activeClubs = clubs.filter(c => c.archived !== true)

  return (
    <div style={{
      minHeight: '100vh', height: '100%', overflowY: 'auto', boxSizing: 'border-box',
      background: T.ink, display: 'flex', flexDirection: 'column',
      alignItems: 'center', padding: '60px 24px',
      fontFamily: T.sans, color: T.white,
    }}>
      <div style={{ marginBottom: 32, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
        <AirKiLockup size={28} color={T.white} />
        <div style={{ ...labelStyle(T.mutedDark), marginTop: 24, marginBottom: 12 }}>
          SUPER ADMIN
        </div>
        <h1 style={{ ...headingStyle(24, T.white), margin: 0 }}>
          Choose a club to operate in
        </h1>
        <div style={{ fontSize: 14, color: T.mutedDark, marginTop: 8 }}>
          You can switch club at any time from the header.
        </div>
      </div>

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 10,
        width: '100%', maxWidth: 440,
      }}>
        {!clubsLoaded && (
          <div style={{ color: T.mutedDark, textAlign: 'center', fontSize: 13, padding: 16 }}>
            Loading clubs…
          </div>
        )}

        {clubsLoaded && clubs.length === 0 && !isCreating && (
          <div style={{
            color: T.mutedDark, textAlign: 'center', fontSize: 13, padding: 16,
            border: T.borderDark, borderRadius: T.radius.md,
          }}>
            No clubs yet. Create the first one below.
          </div>
        )}

        {activeClubs.map(c => {
          // Si on est en train d'éditer ce club, on remplace la row par le form
          if (editingId === c.id) {
            return (
              <ClubFormPanel key={c.id} mode="edit"
                form={form} setForm={setForm}
                saving={saving} error={error}
                onSave={handleSave} onCancel={cancelEdit} />
            )
          }
          return <ClubRow key={c.id} club={c} onSelect={handleSelect} onEdit={openEdit} onDelete={handleDelete} />
        })}

        {isCreating ? (
          <ClubFormPanel mode="create"
            form={form} setForm={setForm}
            saving={saving} error={error}
            onSave={handleSave} onCancel={cancelEdit} />
        ) : !isEditing && (
          <Button onInk onClick={openCreate} style={{ width: '100%', height: 40 }}>
            Create new club
          </Button>
        )}

        {/* Backfill legacy data — visible si aircraft/pilots en base. Carte séparée (outil de maintenance). */}
        {clubs.length > 0 && (allAircraft.length > 0 || allPilots.length > 0) && (
          <div style={{
            marginTop: 32, padding: 16, borderRadius: T.radius.md,
            background: T.ink, border: T.borderDark,
            display: 'flex', flexDirection: 'column', gap: 12,
            fontSize: 13, color: T.white,
          }}>
            <div style={labelStyle(T.mutedDark)}>DATA MIGRATION</div>
            <div style={{ lineHeight: 1.5 }}>
              Total: <span style={monoStyle(13, T.white)}>{allAircraft.length}</span> aircraft,{' '}
              <span style={monoStyle(13, T.white)}>{allPilots.length}</span> pilots.
            </div>
            {orphanCount > 0 && (
              <StatusDot tone="caution" onInk
                text={`${legacyAircraft.length} AIRCRAFT + ${legacyPilots.length} PILOTS WITHOUT A VALID CLUB`} />
            )}
            <select value={backfillTarget} className="ak-focus"
              onChange={e => setBackfillTarget(e.target.value)}
              aria-label="Target club"
              style={inputStyle}>
              <option value="">Pick target club…</option>
              {[...activeClubs].sort((a, b) => compareText(a.code, b.code)).map(c => (
                <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button onInk variant="primary" onClick={() => handleBackfill(false)}
                disabled={!backfillTarget || backfilling || orphanCount === 0}
                title="Fix only orphaned records (missing or invalid clubId)"
                style={{ flex: 1 }}>
                {backfilling ? 'Working…' : `Migrate orphans (${orphanCount})`}
              </Button>
              <Button onInk variant="danger" onClick={() => handleBackfill(true)}
                disabled={!backfillTarget || backfilling}
                title="Reassign EVERY aircraft and pilot to this club (overrides the current clubId)">
                Force all ({allAircraft.length + allPilots.length})
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Ligne club : clic central = sélection, actions Edit / Archive ────────────
function ClubRow({ club: c, onSelect, onEdit, onDelete }) {
  const [hover, setHover] = useState(false)
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch',
      borderRadius: T.radius.md, overflow: 'hidden',
      background: hover ? T.ruleDark : T.ink,
      border: `1px solid ${hover ? T.mutedDark : T.ruleDark}`,
    }}>
      {/* Click central → sélectionne le club */}
      <button onClick={() => onSelect(c.id)} className="ak-focus"
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        style={{
          flex: 1, minWidth: 0, padding: '14px 16px',
          background: 'transparent', border: 'none',
          color: T.white, textAlign: 'left', cursor: 'pointer', fontFamily: T.sans,
        }}
      >
        <div style={{ ...monoStyle(16, T.white), fontWeight: 500, letterSpacing: '0.02em' }}>
          {c.code}
        </div>
        <div style={{ fontSize: 13, color: T.mutedDark, marginTop: 4 }}>
          {c.name}{c.icao ? <> · <span style={{ fontFamily: T.mono }}>{c.icao}</span></> : null}
        </div>
      </button>
      {/* Actions Edit / Archive (super_admin only — déjà gardé par la guard top-level) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px' }}>
        <Button size="sm" onInk onClick={() => onEdit(c)}>Edit</Button>
        <Button size="sm" onInk variant="danger" onClick={() => onDelete(c)}>Archive</Button>
      </div>
    </div>
  )
}

// ─── Sous-composant : form inline pour create/edit ────────────────────────────
function ClubFormPanel({ mode, form, setForm, saving, error, onSave, onCancel }) {
  const isEdit = mode === 'edit'
  return (
    <div style={{
      padding: 16, borderRadius: T.radius.md,
      background: T.ink, border: `1px solid ${T.mutedDark}`,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={labelStyle(T.mutedDark)}>
        {isEdit ? 'EDIT CLUB' : 'NEW CLUB'}
      </div>
      {/* Code : verrouillé en edit (code = doc id Firestore, immutable) */}
      <div>
        <input value={form.code} className="ak-focus"
          onChange={e => isEdit ? null : setForm(p => ({ ...p, code: e.target.value.toUpperCase() }))}
          placeholder="Code (e.g. EBBY-01)" maxLength={12}
          disabled={isEdit} aria-label="Club code"
          style={{ ...inputStyle, width: '100%', fontFamily: T.mono,
            color: isEdit ? T.mutedDark : T.white, cursor: isEdit ? 'not-allowed' : 'text' }} />
        {isEdit && (
          <div style={{ fontSize: 12, color: T.mutedDark, marginTop: 6 }}>
            Code locked — it is the Firestore document id. To change it, archive the club and create a new one.
          </div>
        )}
      </div>
      <input value={form.name} className="ak-focus"
        onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
        placeholder="Name (e.g. ULM Baisy-Thy)" aria-label="Club name"
        style={inputStyle} />
      <input value={form.icao} className="ak-focus"
        onChange={e => setForm(p => ({ ...p, icao: e.target.value.toUpperCase() }))}
        placeholder="ICAO (optional, e.g. EBBY)" maxLength={4} aria-label="ICAO code"
        style={{ ...inputStyle, fontFamily: T.mono }} />
      {error && <StatusDot tone="caution" onInk text={error} />}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <Button onInk onClick={onCancel}>Cancel</Button>
        <Button onInk variant="primary" onClick={onSave} disabled={saving}>
          {saving ? 'Saving…' : isEdit ? 'Save' : 'Create'}
        </Button>
      </div>
    </div>
  )
}

const inputStyle = {
  boxSizing: 'border-box', height: 34,
  background: T.ink, border: T.borderDark,
  color: T.white, fontFamily: T.sans, fontSize: 13,
  padding: '0 10px', borderRadius: T.radius.sm, outline: 'none',
}
