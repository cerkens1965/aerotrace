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
      <path d={PATH} fill={color} fillRule="evenodd" />
      {variant === 'duo' && <path d={INNER} fill="#F5A623" />}
    </svg>
  )
}

// Lockup horizontal : monogramme + mot-marque « AirKi » (Instrument Sans Bold, -0.04em).
// baseline : « Not alone in the sky » à 19,5 % de la taille du mot-marque, Medium ; supprimée sous 60 px.
export function AirKiLockup({ size = 22, color = '#141414', baseline = false, variant = 'duo' }) {
  const gap = Math.round(size * 0.28)   // ≈ demi-largeur de l'apex du A
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap }}>
      <AirKiMark variant={variant} color={color} size={size} />
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
