// SearchBox — champ de recherche AirKi (22/09, sorti d'AdminPage pour Logbook / Fleet / Admin).
// Loupe à gauche, Échap efface, compteur « n OF total » optionnel à droite. 34 px, bord 1 px, focus ambre.
import { T, labelStyle, fieldStyle } from './tokens'
import Icon from './Icon'
import { ensureAirKiStyles } from './styles'

ensureAirKiStyles()

export default function SearchBox({ value, onChange, placeholder = 'Search…', count, total, width = 420, style }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', ...style }}>
      <label style={{ position: 'relative', flex: `1 1 ${Math.min(320, width)}px`, maxWidth: width }}>
        <span aria-hidden="true" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: T.etch, display: 'flex' }}>
          <Icon name="search" size={16} />
        </span>
        <input type="search" value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} aria-label={placeholder}
          className="ak-focus" onKeyDown={e => { if (e.key === 'Escape') onChange('') }}
          style={{ ...fieldStyle(), paddingLeft: 34 }} />
      </label>
      {count != null && total != null && <span style={labelStyle(T.etch)}>{count} OF {total}</span>}
    </div>
  )
}
