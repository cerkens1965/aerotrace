// Button — bouton unique AirKi. variant : primary | secondary | ghost | danger ; size : sm | md.
// Règles DS : radius 4, bordures 1 px, pas d'ombre ; primaire = encre / texte blanc (inversé sur fond
// encre via onInk) ; jamais d'ambre en texte ni en fond de bouton ; focus visible = contour ambre 2 px.
// Pas de text-transform (un bouton peut contenir « AirKi »).
// confirm="Confirm?" : 1er clic arme (le libellé devient le texte de confirm), 2e clic exécute ;
// désarmement automatique après 5 s. Pensé pour 'danger' mais utilisable sur tout variant.
import { useEffect, useState } from 'react'
import { T } from './tokens'
import Icon from './Icon'
import { ensureAirKiStyles } from './styles'

ensureAirKiStyles()

const SIZES = {
  sm: { height: 28, padding: '0 10px', fontSize: 12, gap: 6, icon: 16 },
  md: { height: 34, padding: '0 14px', fontSize: 13, gap: 8, icon: 16 },
}

function palette(variant, onInk, hover, armed, disabled) {
  // Désactivé : couleurs pleines atténuées (pas d'alpha sur le texte).
  if (disabled) {
    return onInk
      ? { bg: 'transparent', fg: T.graphite, border: T.ruleDark }
      : { bg: variant === 'ghost' ? 'transparent' : T.paper, fg: T.etch, border: variant === 'ghost' ? 'transparent' : T.rule }
  }
  if (variant === 'primary') {
    return onInk
      ? { bg: hover ? T.paper : T.white, fg: T.ink, border: hover ? T.paper : T.white }
      : { bg: hover ? T.graphite : T.ink, fg: T.white, border: hover ? T.graphite : T.ink }
  }
  if (variant === 'ghost') {
    return onInk
      ? { bg: hover ? T.ruleDark : 'transparent', fg: T.white, border: 'transparent' }
      : { bg: hover ? T.paper : 'transparent', fg: T.ink, border: 'transparent' }
  }
  if (variant === 'danger') {
    // Armé : bord ambre (statut transitoire), texte encre — l'ambre n'est jamais une couleur de texte.
    if (armed) return onInk ? { bg: T.ink, fg: T.white, border: T.amber } : { bg: T.card, fg: T.ink, border: T.amber }
    return onInk
      ? { bg: 'transparent', fg: T.mutedDark, border: hover ? T.mutedDark : T.ruleDark }
      : { bg: hover ? T.paper : 'transparent', fg: T.graphite, border: hover ? T.graphite : T.rule }
  }
  // secondary
  return onInk
    ? { bg: 'transparent', fg: T.white, border: hover ? T.mutedDark : T.ruleDark }
    : { bg: hover ? T.paper : T.card, fg: T.ink, border: hover ? T.graphite : T.rule }
}

export default function Button({
  variant = 'secondary', size = 'md', onInk = false, confirm, icon, iconRight,
  disabled = false, type = 'button', onClick, children, style, ...rest
}) {
  const [hover, setHover] = useState(false)
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return undefined
    const t = setTimeout(() => setArmed(false), 5000)
    return () => clearTimeout(t)
  }, [armed])

  const handleClick = (e) => {
    if (disabled) return
    if (confirm && !armed) { setArmed(true); return }
    setArmed(false)
    onClick?.(e)
  }

  const sz = SIZES[size] || SIZES.md
  const p = palette(variant, onInk, hover, armed, disabled)
  const renderIcon = (ic) => (typeof ic === 'string' ? <Icon name={ic} size={sz.icon} /> : ic)

  return (
    <button
      type={type}
      className="ak-focus"
      disabled={disabled}
      onClick={handleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onBlur={() => setArmed(false)}
      aria-live={confirm ? 'polite' : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: sz.gap,
        height: sz.height, padding: sz.padding, borderRadius: T.radius.sm,
        border: `1px solid ${p.border}`, background: p.bg, color: p.fg,
        fontFamily: T.sans, fontWeight: 600, fontSize: sz.fontSize, letterSpacing: '-0.01em', lineHeight: 1,
        whiteSpace: 'nowrap', cursor: disabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
      {...rest}
    >
      {icon && renderIcon(icon)}
      {armed ? confirm : children}
      {iconRight && renderIcon(iconRight)}
    </button>
  )
}
