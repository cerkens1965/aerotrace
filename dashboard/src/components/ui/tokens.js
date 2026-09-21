// tokens — jetons du design system AirKi (2026-09) pour les styles inline.
// Miroir des variables CSS de src/index.css ; à importer plutôt que de réécrire des hex dans les pages.
// Règles : ambre jamais en couleur de texte ; ok/info = statut seulement ; pas d'ombre, pas de dégradé,
// bordures 1 px ; libellés mono écrits en capitales DANS la chaîne (aucun text-transform : la marque
// « AirKi » ne doit jamais passer en capitales).
export const T = {
  ink: '#141414',
  paper: '#F4F2ED',
  card: '#FFFFFF',
  white: '#FFFFFF',
  graphite: '#4A4A46',
  etch: '#8D9096',
  rule: '#DDD9D2',
  ruleDark: '#2C2C2C',
  mutedDark: '#9A9A94',
  amber: '#F5A623',
  ok: '#22C55E',
  info: '#60A5FA',
  overlay: 'rgba(20, 20, 20, 0.3)', // encre à 30 %

  sans: 'var(--font-sans)',
  mono: 'var(--font-mono)',

  // Échelle d'espacement du DS : 4 6 8 10 12 14 16 18 22 24 28 32 40 48 72 96.
  space: { 4: 4, 6: 6, 8: 8, 10: 10, 12: 12, 14: 14, 16: 16, 18: 18, 22: 22, 24: 24, 28: 28, 32: 32, 40: 40, 48: 48, 72: 72, 96: 96 },
  // Rayons : 4 boutons/chips · 6 cartes/panneaux · 999 pilule.
  radius: { sm: 4, md: 6, pill: 999 },
  border: '1px solid #DDD9D2',
  borderDark: '1px solid #2C2C2C',
}

// Libellé technique : Geist Mono 10 px, 0.08em. Écrire la chaîne en capitales soi-même.
export const labelStyle = (color = T.etch) => ({
  fontFamily: T.mono, fontSize: 10, fontWeight: 500, letterSpacing: '0.08em', lineHeight: 1.2, color,
})

// Valeur chiffrée : Geist Mono tabulaire, 500, -0.04em.
export const valueStyle = (fontSize = 30, color = T.ink) => ({
  fontFamily: T.mono, fontSize, fontWeight: 500, letterSpacing: '-0.04em', lineHeight: 1,
  fontVariantNumeric: 'tabular-nums', color,
})

// Titre : Instrument Sans 600, -0.02em.
export const headingStyle = (fontSize = 18, color = T.ink) => ({
  fontFamily: T.sans, fontSize, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.25, color,
})

// Texte chiffré courant (tables, tiroirs).
export const monoStyle = (fontSize = 13, color = T.ink) => ({
  fontFamily: T.mono, fontSize, fontVariantNumeric: 'tabular-nums', color,
})
