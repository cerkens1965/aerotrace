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
.ak-nav:not([aria-current]):hover { color: #FFFFFF !important; }
.ak-drawer { width: 440px; }
/* (23/09, chantier mobile) TIROIR → FEUILLE DU BAS sous 640 px. Un panneau latéral pleine
   hauteur sur un téléphone oblige à viser une croix en haut à droite, hors d'atteinte du pouce.
   La feuille monte du bas, s'arrête à 92 % de la hauteur (on voit ce qu'il y a derrière, donc
   on comprend qu'on peut fermer), et réserve la marge de sécurité du bas d'écran. */
@media (max-width: 600px) { .ak-drawer { width: 100%; } }
@media (max-width: 639px) {
  .ak-drawer {
    width: 100% !important; max-width: 100% !important;
    top: auto !important; bottom: 0 !important; right: 0 !important; left: 0 !important;
    height: auto !important; max-height: 92dvh !important;
    border-radius: 12px 12px 0 0 !important;
    padding-bottom: env(safe-area-inset-bottom, 0px) !important;
  }
}
`

export function ensureAirKiStyles() {
  if (typeof document === 'undefined' || document.getElementById(ID)) return
  const el = document.createElement('style')
  el.id = ID
  el.textContent = CSS
  document.head.appendChild(el)
}
