// Drawer — tiroir droit (remplace les modales Assign et Config boîtier).
// Règles DS : panneau 440 px (100 % sous 600 px), fond carte, bord gauche 1 px rule, pas d'ombre ;
// voile encre 30 % ; en-tête titre Semibold 18 + sous-titre Geist Mono etch + bouton fermer ;
// corps défilant ; pied d'actions séparé par un filet. Échap ferme, focus piégé, focus restauré à la fermeture.
// props : open, onClose, title, subtitle, footer (nœud, typiquement des <Button>), children.
import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { T, headingStyle } from './tokens'
import Icon from './Icon'
import { ensureAirKiStyles } from './styles'

ensureAirKiStyles()

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// closeOnOverlay=false : un clic sur le voile ne ferme pas (formulaire long, saisie à protéger) — Échap et le bouton Fermer restent actifs.
export default function Drawer({ open, onClose, title, subtitle, footer, children, closeOnOverlay = true }) {
  const panelRef = useRef(null)
  const titleId = useId()

  // Focus initial + restauration à la fermeture.
  useEffect(() => {
    if (!open) return undefined
    const previous = document.activeElement
    const panel = panelRef.current
    const first = panel?.querySelector(FOCUSABLE)
    ;(first || panel)?.focus()
    return () => { if (previous && typeof previous.focus === 'function') previous.focus() }
  }, [open])

  // Échap ferme ; Tab / Maj+Tab bouclent dans le panneau.
  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); return }
      if (e.key !== 'Tab') return
      const panel = panelRef.current
      if (!panel) return
      const items = Array.from(panel.querySelectorAll(FOCUSABLE))
      if (!items.length) { e.preventDefault(); panel.focus(); return }
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
        e.preventDefault(); last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) {
        e.preventDefault(); first.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000 }}>
      <div aria-hidden="true" onClick={() => { if (closeOnOverlay) onClose?.() }} style={{ position: 'absolute', inset: 0, background: T.overlay }} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
        className="ak-drawer"
        style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, maxWidth: '100%',
          background: T.card, borderLeft: T.border, outline: 'none',
          display: 'flex', flexDirection: 'column', fontFamily: T.sans, color: T.ink,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '16px 16px 14px', borderBottom: T.border }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {title && <h2 id={titleId} style={{ ...headingStyle(18), margin: 0 }}>{title}</h2>}
            {subtitle && (
              <div style={{ marginTop: 4, fontFamily: T.mono, fontSize: 11, fontVariantNumeric: 'tabular-nums', color: T.etch }}>
                {subtitle}
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            className="ak-focus"
            onClick={() => onClose?.()}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32,
              flexShrink: 0, border: T.border, borderRadius: T.radius.sm, background: T.card, color: T.ink, cursor: 'pointer',
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>{children}</div>
        {footer && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, padding: '12px 16px', borderTop: T.border }}>
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}
