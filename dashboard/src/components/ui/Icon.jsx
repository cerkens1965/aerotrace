// Icon — jeu d'icônes unique AirKi : <Icon name="map" size={16|20|24} />.
// Règles DS (Status icons) : grille 24, trait currentColor, extrémités plates (butt), angles vifs (miter),
// pas d'arcs ni d'ondes ; seuls cercles admis : tête (user) et loupe (search). Aucun emoji, aucune icône ronde.
// Trait 1.5 (2 à 16 px). Décoratif par défaut (aria-hidden) ; passer title pour une icône porteuse de sens.
const PATHS = {
  map: ['M3 5 L9 3 L15 5 L21 3 V19 L15 21 L9 19 L3 21 Z', 'M9 3 V19', 'M15 5 V21'],
  list: ['M8 6 H21', 'M8 12 H21', 'M8 18 H21', 'M3 6 H5', 'M3 12 H5', 'M3 18 H5'],
  plane: ['M12 2 L13.5 4.5 V9.5 L22 13.5 V15.5 L13.5 13.5 V18.5 L16 20.5 V22 L12 21 L8 22 V20.5 L10.5 18.5 V13.5 L2 15.5 V13.5 L10.5 9.5 V4.5 Z'],
  play: ['M7 4 L19 12 L7 20 Z'],
  back: ['M15 4 L7 12 L15 20'],
  'chevron-right': ['M9 4 L17 12 L9 20'],
  close: ['M5 5 L19 19', 'M19 5 L5 19'],
  upload: ['M12 15 V3', 'M6 9 L12 3 L18 9', 'M3 16 V21 H21 V16'],
  download: ['M12 3 V15', 'M6 9 L12 15 L18 9', 'M3 16 V21 H21 V16'],
  edit: ['M4 20 V16 L16 4 L20 8 L8 20 Z', 'M13 7 L17 11'],
  archive: ['M3 4 H21 V8 H3 Z', 'M5 8 V20 H19 V8', 'M10 12 H14'],
  check: ['M4 12 L10 18 L20 6'],
  warning: ['M12 3 L22 20 H2 Z', 'M12 9 V14', 'M12 16 V18'],
  refresh: ['M19 13 V19 H5 V5 H17', 'M14 2 L17 5 L14 8'],
  user: ['M4 21 V18 L8 14 H16 L20 18 V21'],
  settings: ['M3 6 H21', 'M3 12 H21', 'M3 18 H21', 'M8 3 V9', 'M16 9 V15', 'M10 15 V21'],
  search: ['M14.5 14.5 L21 21'],
  filter: ['M3 4 H21 L14 12 V20 L10 18 V12 Z'],
  external: ['M14 3 H21 V10', 'M21 3 L11 13', 'M18 14 V21 H3 V6 H10'],
}

// Formes pleines (pas de trait) : barres de signal façon LTE, sans arcs.
const FILLED = {
  wifi: [[3, 15, 4, 6], [10, 10, 4, 11], [17, 4, 4, 17]],
}

// Cercles nécessaires uniquement.
const CIRCLES = {
  user: [[12, 8, 4]],
  search: [[10, 10, 6]],
}


export default function Icon({ name, size = 16, title, color, style }) {
  const sw = size <= 16 ? 2 : 1.5
  const a11y = title ? { role: 'img', 'aria-label': title } : { 'aria-hidden': true, focusable: 'false' }
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} fill="none"
      stroke="currentColor" strokeWidth={sw} strokeLinecap="butt" strokeLinejoin="miter" strokeMiterlimit={10}
      style={{ display: 'block', flexShrink: 0, color, ...style }}
      {...a11y}
    >
      {title && <title>{title}</title>}
      {(PATHS[name] || []).map((d, i) => <path key={i} d={d} />)}
      {(CIRCLES[name] || []).map(([cx, cy, r], i) => <circle key={`c${i}`} cx={cx} cy={cy} r={r} />)}
      {(FILLED[name] || []).map(([x, y, w, h], i) => (
        <rect key={`r${i}`} x={x} y={y} width={w} height={h} fill="currentColor" stroke="none" />
      ))}
    </svg>
  )
}
