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

// Lockup horizontal : monogramme + mot-marque « AirKi » (Instrument Sans Bold, -0.04em).
// baseline : « Not alone in the sky » à 19,5 % de la taille du mot-marque, Medium ; supprimée sous 60 px.
// (21/09) ALIGNEMENT OPTIQUE (retour Christophe « l'équilibre n'est pas bon ») : le A du monogramme a exactement la
// hauteur des capitales du mot (Instrument Sans Bold : capHeight 0,72 em, ascender 0,97, descender 0,25), posé sur la
// même ligne de base et aligné sur le haut des capitales ; la baseline ne décentre plus le monogramme.
//   hauteur visible du A = 84 % du viewBox → côté SVG = 0,72 / 0,84 × corps ≈ 0,857 × corps
//   haut des capitales dans une ligne de hauteur 1 = 0,14 em ; le A commence à 8 % du SVG → marge haute 0,0714 em.
//   écart visible mot ↔ monogramme ≈ 0,2 em (SVG déjà marge de 10 % à droite).
export function AirKiLockup({ size = 22, color = '#141414', baseline = false, variant = 'duo' }) {
  const mark = Math.round(size * 0.857)
  const gap  = Math.round(size * 0.11)
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap }}>
      <AirKiMark variant={variant} color={color} size={mark} style={{ marginTop: Math.round(size * 0.0714) }} />
      <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1 }}>
        <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: size, letterSpacing: '-0.04em', color }}>AirKi</span>
        {baseline && size >= 60 && (
          <span style={{ fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: Math.round(size * 0.195), color, marginTop: 4 }}>
            Not alone in the sky
          </span>
        )}
      </div>
    </div>
  )
}
