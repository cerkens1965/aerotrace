// styles — petite feuille injectée une fois pour ce que le style inline ne sait pas faire :
// :focus-visible (contour ambre 2 px, décalage 2), @keyframes du Skeleton (coupé si
// prefers-reduced-motion) et largeur responsive du Drawer. Aucune ombre, aucun dégradé.
const ID = 'airki-ui-styles'
const CSS = `
.ak-focus:focus { outline: none; }
.ak-focus:focus-visible { outline: 2px solid #F5A623; outline-offset: 2px; }
.ak-row:focus-visible { outline-offset: -2px; }
@keyframes ak-skeleton { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
.ak-skeleton { animation: ak-skeleton 1.6s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .ak-skeleton { animation: none; } }
.ak-drawer { width: 440px; }
@media (max-width: 600px) { .ak-drawer { width: 100%; } }
`

export function ensureAirKiStyles() {
  if (typeof document === 'undefined' || document.getElementById(ID)) return
  const el = document.createElement('style')
  el.id = ID
  el.textContent = CSS
  document.head.appendChild(el)
}
