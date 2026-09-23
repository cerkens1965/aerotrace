// useBreakpoint — point de rupture PARTAGÉ (23/09/2026, chantier mobile).
//
// Un seul endroit décide de ce qu'est « un téléphone » : sans ça, chaque page invente son
// seuil et l'interface se met à changer d'avis d'un écran à l'autre.
//
//   phone   < 640 px   iPhone en portrait, « Duo » plié
//   tablet  < 1024 px  iPad en portrait, « Duo » déplié, iPhone en paysage
//   desktop  ≥ 1024 px
//
// Le pliable ne demande AUCUN traitement particulier : plié il mesure une largeur de
// téléphone, déplié une largeur de tablette — il traverse simplement le seuil, comme une
// rotation. C'est précisément pourquoi on raisonne en LARGEUR et jamais en appareil.
//
// matchMedia plutôt qu'un écouteur de resize : le navigateur ne nous réveille qu'au
// FRANCHISSEMENT du seuil, pas à chaque pixel — et le rendu ne se relance donc pas pendant
// qu'on fait glisser une fenêtre.
import { useState, useEffect } from 'react'

export const BP = { phone: 640, tablet: 1024 }

const read = () => {
  if (typeof window === 'undefined') return 'desktop'
  if (window.matchMedia(`(max-width: ${BP.phone - 1}px)`).matches) return 'phone'
  if (window.matchMedia(`(max-width: ${BP.tablet - 1}px)`).matches) return 'tablet'
  return 'desktop'
}

export default function useBreakpoint() {
  const [bp, setBp] = useState(read)

  useEffect(() => {
    const queries = [
      window.matchMedia(`(max-width: ${BP.phone - 1}px)`),
      window.matchMedia(`(max-width: ${BP.tablet - 1}px)`),
    ]
    const onChange = () => setBp(read())
    queries.forEach(q => q.addEventListener('change', onChange))
    onChange()   // l'état initial peut dater d'un rendu serveur ou d'une rotation avant montage
    return () => queries.forEach(q => q.removeEventListener('change', onChange))
  }, [])

  return { bp, isPhone: bp === 'phone', isTablet: bp === 'tablet', isDesktop: bp === 'desktop',
           isCompact: bp !== 'desktop' }
}
