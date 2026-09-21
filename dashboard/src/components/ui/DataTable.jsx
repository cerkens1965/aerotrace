// DataTable — table unique (Logbook, Fleet, Admin, Dev).
// Règles DS : carte blanche bordée 1 px rule, radius 6, pas d'ombre ; en-têtes Geist Mono 10 px 0.08em etch
// (libellés écrits en capitales dans la chaîne — jamais de text-transform, une table peut contenir « AirKi ») ;
// lignes 13 px, chiffres tabulaires ; survol fond papier ; conteneur overflow-x:auto.
// columns : [{ key, label, align?, mono?, width?, render?(row) }] ; rows ; rowKey (clé ou fn(row, i)) ;
// onRowClick?(row) (ligne cliquable + Entrée au clavier) ; empty (nœud) ; loading (lignes Skeleton).
import { useState } from 'react'
import { T, labelStyle } from './tokens'
import Skeleton from './Skeleton'
import EmptyState from './EmptyState'
import { ensureAirKiStyles } from './styles'

ensureAirKiStyles()

const SKELETON_ROWS = 5

function keyOf(row, i, rowKey) {
  if (typeof rowKey === 'function') return rowKey(row, i)
  if (rowKey && row?.[rowKey] != null) return row[rowKey]
  return row?.id ?? i
}

export default function DataTable({ columns = [], rows = [], rowKey = 'id', onRowClick, empty, loading = false, style }) {
  const [hovered, setHovered] = useState(null)
  const clickable = typeof onRowClick === 'function'

  const th = (c) => ({
    ...labelStyle(T.etch), textAlign: c.align || 'left', width: c.width, whiteSpace: 'nowrap',
    padding: '10px 12px', borderBottom: T.border, background: T.card, fontWeight: 500,
  })
  const td = (c, last) => ({
    textAlign: c.align || 'left', padding: '10px 12px', fontSize: 13, lineHeight: 1.4, color: T.ink,
    fontFamily: c.mono ? T.mono : T.sans, fontVariantNumeric: 'tabular-nums',
    borderBottom: last ? 'none' : T.border, verticalAlign: 'middle',
  })

  let body
  if (loading) {
    body = Array.from({ length: SKELETON_ROWS }, (_, r) => (
      <tr key={`sk${r}`}>
        {columns.map((c) => (
          <td key={c.key} style={td(c, r === SKELETON_ROWS - 1)}>
            <Skeleton width={c.align === 'right' ? '50%' : '70%'} style={c.align === 'right' ? { marginLeft: 'auto' } : undefined} />
          </td>
        ))}
      </tr>
    ))
  } else if (!rows.length) {
    body = (
      <tr>
        <td colSpan={Math.max(columns.length, 1)} style={{ padding: 0 }}>
          {empty ?? <EmptyState text="Nothing to show." />}
        </td>
      </tr>
    )
  } else {
    body = rows.map((row, i) => {
      const k = keyOf(row, i, rowKey)
      const last = i === rows.length - 1
      return (
        <tr
          key={k}
          className={clickable ? 'ak-focus ak-row' : undefined}
          tabIndex={clickable ? 0 : undefined}
          onClick={clickable ? () => onRowClick(row) : undefined}
          onKeyDown={clickable ? (e) => { if (e.key === 'Enter') onRowClick(row) } : undefined}
          onMouseEnter={() => setHovered(k)}
          onMouseLeave={() => setHovered((h) => (h === k ? null : h))}
          style={{ background: hovered === k ? T.paper : T.card, cursor: clickable ? 'pointer' : 'default' }}
        >
          {columns.map((c) => (
            <td key={c.key} style={td(c, last)}>{c.render ? c.render(row) : row?.[c.key]}</td>
          ))}
        </tr>
      )
    })
  }

  return (
    <div style={{ background: T.card, border: T.border, borderRadius: T.radius.md, overflow: 'hidden', ...style }}>
      <div style={{ overflowX: 'auto' }}>
        <table aria-busy={loading || undefined} style={{ width: '100%', borderCollapse: 'collapse', fontFamily: T.sans }}>
          <thead>
            <tr>{columns.map((c) => <th key={c.key} scope="col" style={th(c)}>{c.label}</th>)}</tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
    </div>
  )
}
