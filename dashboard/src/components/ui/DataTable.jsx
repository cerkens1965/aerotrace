// DataTable — table unique (Logbook, Fleet, Admin, Dev).
// Règles DS : carte blanche bordée 1 px rule, radius 6, pas d'ombre ; en-têtes Geist Mono 10 px 0.08em etch
// (libellés écrits en capitales dans la chaîne — jamais de text-transform, une table peut contenir « AirKi ») ;
// lignes 13 px, chiffres tabulaires ; survol fond papier ; conteneur overflow-x:auto.
// columns : [{ key, label, align?, mono?, width?, render?(row), sortValue?(row) }] ; rows ; rowKey ;
//
// (24/09, Christophe) TRI PAR EN-TÊTE. Une colonne est triable si elle fournit `sortValue`, ou si
// sa valeur brute est un texte ou un nombre — on ne propose pas de trier ce qu'on ne sait pas
// comparer. L'en-tête ACTIF passe en encre (les autres restent en etch) et porte un chevron :
// la couleur dit QUELLE colonne trie, le chevron dit dans quel SENS. Sans tri actif, l'ordre
// reçu du parent est conservé — c'est lui qui sait, par exemple, reléguer les archivés.
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

const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

export default function DataTable({ columns = [], rows: rawRows = [], rowKey = 'id', onRowClick, empty, loading = false, style }) {
  const [hovered, setHovered] = useState(null)
  const [sort, setSort] = useState(null)        // { key, dir: 'asc' | 'desc' }
  const { isPhone } = useBreakpoint()
  const clickable = typeof onRowClick === 'function'

  const valueOf = (c, row) => (c.sortValue ? c.sortValue(row) : row?.[c.key])
  const sortableOf = (c) => {
    if (!c.label) return false
    if (c.sortValue) return true
    const v = rawRows.length ? rawRows[0]?.[c.key] : undefined
    return typeof v === 'string' || typeof v === 'number'
  }

  const rows = useMemo(() => {
    if (!sort) return rawRows
    const c = columns.find(x => x.key === sort.key)
    if (!c) return rawRows
    const dir = sort.dir === 'desc' ? -1 : 1
    return [...rawRows].sort((a, b) => {
      const va = valueOf(c, a), vb = valueOf(c, b)
      // Une valeur absente va TOUJOURS à la fin, quel que soit le sens : « pas de valeur » n'est
      // pas une valeur, et la voir remonter en tête au premier clic n'aide personne.
      const ea = va == null || va === '', eb = vb == null || vb === ''
      if (ea || eb) return ea && eb ? 0 : ea ? 1 : -1
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
      return collator.compare(String(va), String(vb)) * dir
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawRows, sort, columns])

  const toggleSort = (key) => setSort(s => (
    s?.key === key ? (s.dir === 'asc' ? { key, dir: 'desc' } : null) : { key, dir: 'asc' }
  ))

  const th = (c) => ({
    ...labelStyle(sort?.key === c.key ? T.ink : T.etch), textAlign: c.align || 'left', width: c.width,
    whiteSpace: 'nowrap', padding: '10px 12px', borderBottom: T.border, background: T.card, fontWeight: 500,
  })
  // En-tête cliquable : le libellé reste un libellé (pas de bouton visible), seul le curseur et
  // le chevron signalent qu'on peut trier. Troisième clic = retour à l'ordre du parent.
  const thContent = (c) => {
    if (!sortableOf(c)) return c.label
    const active = sort?.key === c.key
    return (
      <span role="button" tabIndex={0} className="ak-focus"
        onClick={() => toggleSort(c.key)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort(c.key) } }}
        title={active ? (sort.dir === 'asc' ? 'Sorted A→Z — click for Z→A' : 'Sorted Z→A — click to clear') : 'Sort by this column'}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
                 justifyContent: c.align === 'right' ? 'flex-end' : 'flex-start' }}>
        {c.label}
        <span aria-hidden="true" style={{ display: 'flex', width: 12, color: active ? T.ink : 'transparent',
          transform: active && sort.dir === 'desc' ? 'rotate(90deg)' : 'rotate(-90deg)' }}>
          <Icon name="chevron-right" size={12} />
        </span>
      </span>
    )
  }
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
            <tr>{columns.map((c) => (
              <th key={c.key} scope="col" style={th(c)}
                aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                {thContent(c)}
              </th>
            ))}</tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
    </div>
  )
}
