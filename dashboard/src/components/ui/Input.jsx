// Input / Select — champs de saisie AirKi (22/09, sortis d'Admin). 34 px, bord 1 px, rayon 4, focus ambre au clavier.
// onChange reçoit la VALEUR (pas l'événement). mono = identifiants et chiffres. onInk = sur panneau encre.
// Les autres props (id, name, autoFocus, disabled, list, onKeyDown, inputMode…) passent à l'élément natif.
import { fieldStyle } from './tokens'
import { ensureAirKiStyles } from './styles'

ensureAirKiStyles()

export default function Input({ value, onChange, type = 'text', mono = false, onInk = false, style, ...rest }) {
  return (
    <input type={type} value={value ?? ''} onChange={e => onChange?.(e.target.value)} className="ak-focus"
      style={{ ...fieldStyle({ onInk, mono }), ...style }} {...rest} />
  )
}

// options : [{ value, label }] ; placeholder = première option vide non choisissable.
export function Select({ value, onChange, options = [], placeholder, mono = false, onInk = false, style, ...rest }) {
  return (
    <select value={value ?? ''} onChange={e => onChange?.(e.target.value)} className="ak-focus"
      style={{ ...fieldStyle({ onInk, mono }), cursor: 'pointer', ...style }} {...rest}>
      {placeholder != null && <option value="" disabled>{placeholder}</option>}
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  )
}
