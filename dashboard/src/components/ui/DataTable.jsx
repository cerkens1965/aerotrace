// DataTable — table unique (Logbook, Fleet, Admin, Dev).
// Règles DS : carte blanche bordée 1 px rule, radius 6, pas d'ombre ; en-têtes Geist Mono 10 px 0.08em etch
// (libellés écrits en capitales dans la chaîne — jamais de text-transform, une table peut contenir « AirKi ») ;
// lignes 13 px, chiffres tabulaires ; survol fond papier ; conteneur overflow-x:auto.
// columns : [{ key, label, align?, mono?, width?, render?(row) }] ; rows ; rowKey (clé ou fn(row, i)) ;
// Sur TÉLÉPHONE (carte par ligne), trois options par colonne — sans effet sur la table :
//   phone: 'hide'   la colonne disparaît de la carte ;
//   phone: 'minor'  elle passe en pied de carte, sur une ligne dense, sans son libellé ;
//   phoneRender(row) rendu plus court que celui de la table (une ligne au lieu de deux…).
// onRowClick?(row) (ligne cliquable + Entrée au clavier) ; empty (nœud) ; loading (lignes Skeleton).
import { useState } from 'react'
import useBreakpoint from '../../hooks/useBreakpoint'
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
  const { isPhone } = useBreakpoint()
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

  // ── (23/09, chantier mobile) SUR TÉLÉPHONE, UNE LIGNE DEVIENT UNE CARTE ───────────────
  // Le repli actuel — overflow-x — laissait un tableau de 8 à 11 colonnes qu'il fallait faire
  // glisser latéralement, en perdant à chaque geste la colonne d'identité. On rend donc, sous
  // 640 px, une carte par ligne : l'identité en tête (1re colonne), les mesures en paires
  // libellé/valeur, les actions en pied. Une seule correction ici et Logbook, Fleet, Admin et
  // Dev deviennent lisibles d'un coup — c'est tout l'intérêt d'avoir un composant unique.
  // Les colonnes sans libellé (actions, cases à cocher) ne deviennent pas des paires : elles
  // n'ont rien à annoncer, elles se rangent en pied de carte.
  if (isPhone && !loading && rows.length) {
    const [head, ...rest] = columns
    const shown  = rest.filter(c => c.phone !== 'hide')
    const fields = shown.filter(c => c.label && c.phone !== 'minor')
    const minor  = shown.filter(c => c.label && c.phone === 'minor')
    const tools  = shown.filter(c => !c.label)
    const cell   = (c, row) => (c.phoneRender ? c.phoneRender(row) : c.render ? c.render(row) : row?.[c.key])
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, ...style }}>
        {rows.map((row, i) => {
          const k = keyOf(row, i, rowKey)
          return (
            <div key={k}
              className={clickable ? 'ak-focus' : undefined}
              tabIndex={clickable ? 0 : undefined}
              onClick={clickable ? () => onRowClick(row) : undefined}
              onKeyDown={clickable ? (e) => { if (e.key === 'Enter') onRowClick(row) } : undefined}
              style={{ background: T.card, border: T.border, borderRadius: T.radius.md,
                padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8,
                cursor: clickable ? 'pointer' : 'default' }}>
              <div style={{ fontSize: 14, color: T.ink, fontFamily: head?.mono ? T.mono : T.sans, minWidth: 0 }}>
                {head ? cell(head, row) : null}
              </div>
              {fields.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '7px 14px' }}>
                  {fields.map(c => (
                    <div key={c.key} style={{ minWidth: 0 }}>
                      <div style={labelStyle(T.etch)}>{c.label}</div>
                      <div style={{ fontSize: 13, color: T.ink, marginTop: 1,
                        fontFamily: c.mono ? T.mono : T.sans, fontVariantNumeric: 'tabular-nums' }}>
                        {cell(c, row)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {minor.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px',
                  fontSize: 12, color: T.graphite, minWidth: 0 }}>
                  {minor.map(c => <span key={c.key} style={{ minWidth: 0 }}>{cell(c, row)}</span>)}
                </div>
              )}
              {tools.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
                  borderTop: T.border, paddingTop: 8 }}>
                  {tools.map(c => <div key={c.key}>{cell(c, row)}</div>)}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
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
