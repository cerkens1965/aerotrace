// AirKiMark — monogramme AirKi (design system AirKi, 2026-09).
// Un seul chemin evenodd sur un viewBox 100x100 ; le 2e sous-chemin est la contreforme.
//   variant="duo"  : chemin encre (ou blanc en inversé) + triangle ambre dans la contreforme.
//   variant="mono" : chemin seul, contreforme ouverte (gravure, broderie, fonds ambre, < 6 mm, monochrome).
// Minimum 16 px à l'écran. Jamais de dégradé, jamais d'ombre.
const PATH  = 'M10 92 L38 8 L62 8 L90 92 L70 92 L63.3 74 L36.7 74 L30 92 Z M50 32 L40 62 L60 62 Z'
const INNER = 'M50 32 L40 62 L60 62 Z'

export default function AirKiMark({ variant = 'duo', color = '#141414', size = 24, title = 'AirKi', style }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={title} style={{ display: 'block', flexShrink: 0, ...style }}>
      {/* (21/09) ambre DESSOUS, légèrement débordant, puis le A par-dessus : plus de liseré sombre d'anticrénelage
          entre la contreforme et le triangle ambre (visible sur fond encre). Rendu identique au tracé officiel. */}
      {variant === 'duo' && <path d={INNER} fill="#F5A623" stroke="#F5A623" strokeWidth="2.5" strokeLinejoin="miter" />}
      <path d={PATH} fill={color} fillRule="evenodd" />
    </svg>
  )
}

// Lockup horizontal (22/09, correction Christophe) : le GRAND A du monogramme (ambre dans la contreforme) EST la
// première lettre, suivi de « irKi » plus petit, COLLÉ et sur la MÊME LIGNE DE BASE → se lit comme un mot : AirKi.
// Avant : monogramme + mot complet « AirKi » = se lisait « A AirKi ».
// Proportions relevées sur la maquette : hauteur du A ≈ 1,55 × hauteur des capitales du texte ; écart A ↔ i ≈ 8 %
// de la hauteur du A. K reste en capitale (règle de marque : jamais « Airki », KI = IA en allemand).
//   size = hauteur visible du A (px). Le A occupe 84 % du viewBox (y 8 → 92) et 80 % en largeur (x 10 → 90).
//   texte : capHeight Instrument Sans Bold 0,72 em → corps = size / (1,55 × 0,72).
// baseline « Not alone in the sky » : 19,5 % du corps du mot, Medium ; seulement si size ≥ 60.
export function AirKiLockup({ size = 22, color = '#141414', baseline = false, variant = 'duo' }) {
  const svg  = size / 0.84                    // côté du SVG pour un A visible de `size` px
  const font = size / (1.55 * 0.72)           // corps de « irKi »
  const gap  = size * 0.08
  return (
    <div role="img" aria-label="AirKi" style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start' }}>
      {/* (22/09) Calage CALCULÉ, pas « baseline » : en flex, le navigateur aligne le bas de la boîte du SVG (marge de
          8 % sous le A comprise) → « irKi » tombait sous le pied du A. Ici tout est aligné sur le bas du conteneur :
          SVG remonté de 8 % (pied du A = bas) ; texte en line-height 1, Instrument Sans (ascender 0,97, descender 0,25)
          → ligne de base à 0,86 em du haut, soit 0,14 em au-dessus du bas de la ligne → remonté de 0,14 em.
          Approche gauche du « i » (0,055 em) retirée pour que l'écart A ↔ i soit exactement `gap`. Métriques vérifiées dans la fonte. */}
      <div aria-hidden="true" style={{ display: 'flex', alignItems: 'flex-end' }}>
        <AirKiMark variant={variant} color={color} size={svg} title=""
          style={{ marginLeft: -svg * 0.10, marginRight: -svg * 0.10 + gap, marginBottom: -svg * 0.08 }} />
        <span style={{ display: 'block', fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: font, letterSpacing: '-0.04em',
                       lineHeight: 1, marginBottom: -font * 0.14, marginLeft: -font * 0.055, color }}>irKi</span>
      </div>
      {baseline && size >= 60 && (
        <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: Math.round(font * 0.195), color, marginTop: Math.round(size * 0.12) }}>
          Not alone in the sky
        </span>
      )}
    </div>
  )
}
