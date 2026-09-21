// useOwnerNames — pilotId → « Prénom Nom » pour les pilotes du club (22/09).
// Sert à afficher le propriétaire d'un avion privé (ownership 'owner' + ownerPilotId) sur Live et In flight.
import { useEffect, useState } from 'react'
import { collection, getDocs, query, where } from 'firebase/firestore'
import { db } from '../firebase/config'

export default function useOwnerNames(clubId) {
  const [owners, setOwners] = useState({})
  useEffect(() => {
    if (!clubId) return
    let on = true
    getDocs(query(collection(db, 'pilots'), where('clubId', '==', clubId)))
      .then(snap => {
        const m = {}
        snap.docs.forEach(d => { const p = d.data(); m[d.id] = [p.firstName, p.lastName].filter(Boolean).join(' ') || p.trigram || '' })
        if (on) setOwners(m)
      })
      .catch(err => console.warn('[useOwnerNames]', err?.message || err))
    return () => { on = false }
  }, [clubId])
  return owners
}

export const ownerOf = (ac, owners) =>
  (ac.ownership === 'owner' && ac.ownerPilotId) ? (owners[ac.ownerPilotId] || null) : null
