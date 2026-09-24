// claim.js — appel de la fonction cloud `claimFlight` (24/09/2026, copropriété).
//
// Un seul endroit pour cet appel : il est fait depuis deux écrans (la section « To confirm »
// et le bouton « Not me » d'un vol déjà attribué), et c'est le SEUL chemin par lequel un
// pilote touche à un vol — les règles Firestore réservent l'écriture des vols aux
// instructeurs et aux admins, la fonction vérifie côté serveur qu'il est bien candidat.
//
// Séparé du composant : un module de composants qui exporte aussi des fonctions casse le
// rafraîchissement à chaud de Vite.
import { httpsCallable } from 'firebase/functions'
import { functions } from '../firebase/config'

const fn = httpsCallable(functions, 'claimFlight')

// mine = true  → je revendique ce vol
// mine = false → ce n'est pas moi (récuse une revendication, ou REND un vol auto-attribué)
// Retourne { state: 'claimed' | 'conflict' | 'declined' | 'unclaimed' | 'released' | 'already-yours' }
export async function claimFlight(flightId, mine = true) {
  const { data } = await fn({ flightId, mine })
  return data || {}
}
