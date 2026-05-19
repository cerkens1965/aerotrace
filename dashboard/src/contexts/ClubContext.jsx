import { createContext, useContext, useState, useEffect } from 'react'
import { collection, query, orderBy, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase/config'

// ─── ClubContext ──────────────────────────────────────────────────────────────
// Source de vérité pour le club courant dans toute l'app.
//
// Modèle :
//  - super_admin → peut switcher entre tous les clubs. clubId persisté
//    en localStorage. Sans sélection → la page parent doit rediriger vers
//    /select-club.
//  - admin / instructor / user avec users/{uid}.clubId → clubId imposé,
//    pas de switch possible (le state est synchronisé sur userClubId).
//  - admin sans clubId → hasClub=false, l'app doit afficher un message.
//
const ClubContext = createContext(null)

const LS_KEY = 'aerotrace.clubId'

export function ClubProvider({ role, userClubId, children }) {
  const isSuperAdmin = role === 'super_admin'
  const [clubs, setClubs] = useState([])
  const [clubsLoaded, setClubsLoaded] = useState(false)

  // clubId courant — initialisé selon le rôle :
  //  • super_admin : restaure depuis localStorage (peut être vide)
  //  • autre : utilisera userClubId (set par l'effet ci-dessous)
  const [clubId, setClubIdState] = useState(() => {
    if (typeof window === 'undefined') return ''
    return localStorage.getItem(LS_KEY) || ''
  })

  // Pour les non-super_admin, le club est forcé sur userClubId.
  useEffect(() => {
    if (!isSuperAdmin) {
      setClubIdState(userClubId || '')
    }
  }, [isSuperAdmin, userClubId])

  // Chargement temps réel des clubs (pour le picker + l'affichage du nom).
  useEffect(() => {
    const q = query(collection(db, 'clubs'), orderBy('code'))
    const unsub = onSnapshot(
      q,
      (snap) => {
        setClubs(snap.docs.map((d) => ({ id: d.id, ...d.data() })))
        setClubsLoaded(true)
      },
      (err) => {
        console.error('[ClubContext] clubs load:', err)
        setClubsLoaded(true)
      }
    )
    return unsub
  }, [])

  // Setter — utilisé par SelectClubPage et le bouton Switch du Header.
  // Persiste uniquement pour super_admin (les autres ont un clubId imposé).
  const setClub = (newClubId) => {
    setClubIdState(newClubId || '')
    if (isSuperAdmin) {
      if (newClubId) localStorage.setItem(LS_KEY, newClubId)
      else           localStorage.removeItem(LS_KEY)
    }
  }

  const club    = clubs.find((c) => c.id === clubId) || null
  const hasClub = !!clubId

  return (
    <ClubContext.Provider value={{
      clubId, club, clubs, clubsLoaded,
      isSuperAdmin, hasClub,
      setClub,
    }}>
      {children}
    </ClubContext.Provider>
  )
}

export function useClub() {
  const ctx = useContext(ClubContext)
  if (!ctx) throw new Error('useClub() must be called inside <ClubProvider>')
  return ctx
}
