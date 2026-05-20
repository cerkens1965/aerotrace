import { useState, useEffect } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { collection, setDoc, updateDoc, doc, getDoc, serverTimestamp, getDocs, writeBatch } from 'firebase/firestore'
import { db } from '../firebase/config'
import { useClub } from '../contexts/ClubContext'

// ─── SelectClubPage ───────────────────────────────────────────────────────────
// Entrée obligatoire pour super_admin sans club courant : choix d'un club
// existant OU création d'un nouveau club (création inline, pas besoin de
// repasser par AdminPage).
//
// Les non-super_admin n'ont rien à faire ici : redirect vers /live.
export default function SelectClubPage() {
  const { clubs, clubsLoaded, isSuperAdmin, setClub } = useClub()
  const navigate = useNavigate()
  const [editingId, setEditingId] = useState(null)   // null = not editing | '' = create | id = edit existing
  const [form, setForm]           = useState({ code: '', name: '', icao: '' })
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')

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
    if (!codeUp) return setError('Code must contain letters/digits/dash/underscore')
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
          setError(`A club with id "${codeUp}" already exists in Firestore. Pick another code or delete the existing one first.`)
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
    if (!window.confirm(`Archive club ${c.code} — ${c.name}? Existing pilots/aircraft linked to it will remain in Firestore but become orphaned.`)) return
    try {
      await updateDoc(doc(db, 'clubs', c.id), { archived: true, updatedAt: serverTimestamp() })
    } catch (e) { window.alert(`Delete failed: ${e.message}`) }
  }

  // ── Backfill legacy data ─────────────────────────────────────────────────
  // Détecte deux cas :
  //  • clubId manquant (legacy avant l'ajout du champ)
  //  • clubId orphelin (pointe vers un club inexistant ou archivé)
  // Tout est listé en bloc pour permettre un backfill bulk vers un club existant.
  const [legacyAircraft, setLegacyAircraft] = useState([])
  const [legacyPilots,   setLegacyPilots]   = useState([])
  const [allAircraft,    setAllAircraft]    = useState([])
  const [allPilots,      setAllPilots]      = useState([])
  const [backfillTarget, setBackfillTarget] = useState('')
  const [backfilling,    setBackfilling]    = useState(false)

  useEffect(() => {
    if (!clubsLoaded) return
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
  }, [clubs, clubsLoaded])

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

  return (
    <div style={{
      minHeight: '100vh', background: '#050814',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', padding: '60px 24px',
      fontFamily: 'monospace', color: '#fff',
    }}>
      <div style={{ marginBottom: 32, textAlign: 'center' }}>
        <img
          src="/AerotrAce_AeroTrace.png"
          alt="Aerotrace"
          style={{
            height: 28,
            filter: 'brightness(0) invert(1)',
            opacity: 0.9,
            marginBottom: 8,
          }}
        />
        <div style={{
          fontSize: 10, letterSpacing: '0.3em',
          color: 'rgba(245,166,35,0.7)', marginBottom: 16,
        }}>
          SUPER ADMIN
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>
          Choose a club to operate in
        </h1>
        <div style={{
          fontSize: 12, color: 'rgba(255,255,255,0.5)', marginTop: 8,
        }}>
          You can switch club anytime from the header.
        </div>
      </div>

      <div style={{
        display: 'flex', flexDirection: 'column', gap: 12,
        width: '100%', maxWidth: 420,
      }}>
        {/* Backfill legacy data — visible si aircraft/pilots sans clubId ou orphelins */}
        {clubs.length > 0 && (allAircraft.length > 0 || allPilots.length > 0) && (
          <div style={{
            padding: '12px 14px', borderRadius: 10,
            background: 'rgba(245,166,35,0.08)',
            border: '1px solid rgba(245,166,35,0.3)',
            display: 'flex', flexDirection: 'column', gap: 10,
            fontFamily: 'monospace', fontSize: 11, color: '#fff',
          }}>
            <div style={{ fontSize: 9, letterSpacing: '0.15em', color: '#F5A623', fontWeight: 700 }}>
              DATA MIGRATION
            </div>
            <div style={{ color: 'rgba(255,255,255,0.85)' }}>
              Total : <strong>{allAircraft.length}</strong> aircraft, <strong>{allPilots.length}</strong> pilots.
              {(legacyAircraft.length > 0 || legacyPilots.length > 0) && (
                <span style={{ color: '#F5A623' }}>
                  {' '}({legacyAircraft.length} aircraft + {legacyPilots.length} pilots without valid clubId)
                </span>
              )}
            </div>
            <select value={backfillTarget}
              onChange={e => setBackfillTarget(e.target.value)}
              style={inputStyle}>
              <option value="">— pick target club —</option>
              {clubs.filter(c => c.archived !== true).map(c => (
                <option key={c.id} value={c.id}>{c.code} — {c.name}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button onClick={() => handleBackfill(false)}
                disabled={!backfillTarget || backfilling || (legacyAircraft.length + legacyPilots.length === 0)}
                title="Fix only orphaned docs (no/invalid clubId)"
                style={{ ...btnPrimary, opacity: (!backfillTarget || backfilling || (legacyAircraft.length + legacyPilots.length === 0)) ? 0.5 : 1, flex: 1 }}>
                {backfilling ? '…' : `MIGRATE ORPHANS (${legacyAircraft.length + legacyPilots.length})`}
              </button>
              <button onClick={() => handleBackfill(true)}
                disabled={!backfillTarget || backfilling}
                title="Reassign EVERY aircraft+pilot to this club (overrides current clubId)"
                style={{
                  padding: '7px 14px', borderRadius: 6, cursor: 'pointer',
                  background: 'transparent',
                  border: '1px solid rgba(239,68,68,0.5)',
                  color: '#ef4444', fontFamily: 'monospace', fontSize: 10, fontWeight: 700,
                  letterSpacing: '0.05em',
                  opacity: (!backfillTarget || backfilling) ? 0.4 : 1,
                }}>
                FORCE ALL ({allAircraft.length + allPilots.length})
              </button>
            </div>
          </div>
        )}

        {!clubsLoaded && (
          <div style={{
            color: 'rgba(255,255,255,0.5)', textAlign: 'center',
            fontSize: 12, padding: 16,
          }}>Loading clubs…</div>
        )}

        {clubsLoaded && clubs.length === 0 && !isCreating && (
          <div style={{
            color: 'rgba(255,255,255,0.5)', textAlign: 'center',
            fontSize: 12, padding: 16, border: '1px dashed rgba(255,255,255,0.15)',
            borderRadius: 8,
          }}>
            No clubs yet. Create the first one below.
          </div>
        )}

        {clubs.filter(c => c.archived !== true).map(c => {
          // Si on est en train d'éditer ce club, on remplace la row par le form
          if (editingId === c.id) {
            return (
              <ClubFormPanel key={c.id} mode="edit"
                form={form} setForm={setForm}
                saving={saving} error={error}
                onSave={handleSave} onCancel={cancelEdit} />
            )
          }
          return (
            <div key={c.id} style={{
              display: 'flex', alignItems: 'stretch', gap: 0,
              borderRadius: 10, overflow: 'hidden',
              background: 'rgba(245,166,35,0.06)',
              border: '1px solid rgba(245,166,35,0.25)',
            }}>
              {/* Click central → sélectionne le club */}
              <button onClick={() => handleSelect(c.id)}
                style={{
                  flex: 1, padding: '16px 18px',
                  background: 'transparent', border: 'none',
                  color: '#fff', textAlign: 'left', cursor: 'pointer',
                  fontFamily: 'monospace',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(245,166,35,0.08)' }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
              >
                <div style={{ fontSize: 16, fontWeight: 700, color: '#F5A623' }}>
                  {c.code}
                </div>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', marginTop: 4 }}>
                  {c.name}{c.icao ? ` · ${c.icao}` : ''}
                </div>
              </button>
              {/* Actions Edit / Delete (super_admin only — déjà gardé par la guard top-level) */}
              <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4, padding: '0 12px' }}>
                <button onClick={() => openEdit(c)} style={btnRowAction}>EDIT</button>
                <button onClick={() => handleDelete(c)} style={btnRowDelete}>DELETE</button>
              </div>
            </div>
          )
        })}

        {isCreating ? (
          <ClubFormPanel mode="create"
            form={form} setForm={setForm}
            saving={saving} error={error}
            onSave={handleSave} onCancel={cancelEdit} />
        ) : !isEditing && (
          <button onClick={openCreate}
            style={{
              padding: 14, borderRadius: 10,
              background: 'transparent',
              border: '1px dashed rgba(255,255,255,0.2)',
              color: 'rgba(255,255,255,0.6)', cursor: 'pointer',
              fontFamily: 'monospace', fontSize: 12,
              transition: 'all 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.4)' }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'rgba(255,255,255,0.6)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)' }}
          >
            + Create new club
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Sous-composant : form inline pour create/edit ────────────────────────────
function ClubFormPanel({ mode, form, setForm, saving, error, onSave, onCancel }) {
  const isEdit = mode === 'edit'
  return (
    <div style={{
      padding: 16, borderRadius: 10,
      background: 'rgba(255,255,255,0.04)',
      border: '1px solid rgba(255,255,255,0.15)',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ fontSize: 10, letterSpacing: '0.12em', color: 'rgba(255,255,255,0.5)' }}>
        {isEdit ? 'EDIT CLUB' : 'NEW CLUB'}
      </div>
      {/* Code : verrouillé en edit (code = doc id Firestore, immutable) */}
      <div>
        <input value={form.code}
          onChange={e => isEdit ? null : setForm(p => ({ ...p, code: e.target.value.toUpperCase() }))}
          placeholder="Code (e.g. EBBY-01)" maxLength={12}
          disabled={isEdit}
          style={{ ...inputStyle, width: '100%',
            opacity: isEdit ? 0.5 : 1, cursor: isEdit ? 'not-allowed' : 'text' }} />
        {isEdit && (
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>
            Code locked — it's the Firestore document id. To change, delete and recreate.
          </div>
        )}
      </div>
      <input value={form.name}
        onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
        placeholder="Name (e.g. ULM Baisy-Thy)"
        style={inputStyle} />
      <input value={form.icao}
        onChange={e => setForm(p => ({ ...p, icao: e.target.value.toUpperCase() }))}
        placeholder="ICAO (optional, e.g. EBBY)" maxLength={4}
        style={inputStyle} />
      {error && (
        <div style={{ fontSize: 11, color: '#ef4444' }}>{error}</div>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={btnSecondary}>CANCEL</button>
        <button onClick={onSave} disabled={saving}
          style={{ ...btnPrimary, opacity: saving ? 0.5 : 1 }}>
          {saving ? '…' : isEdit ? 'UPDATE' : 'CREATE'}
        </button>
      </div>
    </div>
  )
}

const inputStyle = {
  background: 'rgba(0,0,0,0.3)',
  border: '1px solid rgba(255,255,255,0.15)',
  color: '#fff', fontFamily: 'monospace', fontSize: 12,
  padding: '8px 10px', borderRadius: 6, outline: 'none',
}
const btnSecondary = {
  padding: '7px 14px', borderRadius: 6, cursor: 'pointer',
  background: 'transparent', border: '1px solid rgba(255,255,255,0.2)',
  color: 'rgba(255,255,255,0.7)', fontFamily: 'monospace', fontSize: 10,
}
const btnPrimary = {
  padding: '7px 16px', borderRadius: 6, cursor: 'pointer',
  background: '#F5A623', border: 'none',
  color: '#0a0e1e', fontFamily: 'monospace', fontSize: 10, fontWeight: 700,
}
const btnRowAction = {
  padding: '5px 12px', borderRadius: 5, cursor: 'pointer',
  background: 'transparent', border: '1px solid rgba(255,255,255,0.2)',
  color: 'rgba(255,255,255,0.7)', fontFamily: 'monospace', fontSize: 9,
  fontWeight: 700, letterSpacing: '0.08em',
}
const btnRowDelete = {
  padding: '5px 12px', borderRadius: 5, cursor: 'pointer',
  background: 'transparent', border: '1px solid rgba(239,68,68,0.3)',
  color: '#ef4444', fontFamily: 'monospace', fontSize: 9,
  fontWeight: 700, letterSpacing: '0.08em',
}
