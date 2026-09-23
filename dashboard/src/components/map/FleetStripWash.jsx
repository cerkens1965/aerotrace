// FleetStripWash — le résumé flotte d'UNE LIGNE, en lavis, posé en haut de la carte
// (Claude Design « Live on iPad/iPhone », 23/09/2026).
//
// Pourquoi un composant distinct plutôt qu'un mode du FleetStrip de bureau : celui-ci est un
// panneau ENCRE sur deux lignes, avec séparateurs, répartition club/owner au survol et lien
// vers la page In flight. Posé sur un téléphone il masquait la carte et les boutons de zoom
// (constaté sur iPhone). Ici on garde le strict nécessaire — les trois comptes et les immats
// en vol, tapables pour centrer — sur un lavis à 18 % qui laisse voir la carte dessous
// (règle 8b : rien d'opaque ne se pose sur une carte).
//
// Au sol, la ligne se lit « 0 in flight · 11 not reporting » : c'est l'état normal d'un club
// le soir, et il ne doit pas ressembler à une alerte — d'où le point ambre sur le seul compte
// « not reporting », et rien d'autre.
import { T, monoStyle } from '../ui'
import { posOf } from './fleetPos'

const ident = (a) => a.callSign || a.registration || '?'

export default function FleetStripWash({ inFlight = [], onGround = [], noSignal = [], onLocate }) {
  const dot = (color) => (
    <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 999, background: color, flexShrink: 0 }} />
  )
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'nowrap', overflowX: 'auto',
      padding: '8px 12px', borderRadius: 6, maxWidth: '100%', pointerEvents: 'auto',
      background: 'rgba(244,242,237,0.18)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      border: '1px solid rgba(20,20,20,0.28)',
      scrollbarWidth: 'none',
    }}>
      <span style={{ ...monoStyle(11, T.graphite), letterSpacing: '0.08em', flexShrink: 0 }}>FLEET</span>

      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
        {dot(inFlight.length ? T.ok : T.etch)}
        <span style={{ ...monoStyle(12, T.ink), fontWeight: 500 }}>{inFlight.length}</span>
        <span style={{ ...monoStyle(11, T.graphite) }}>IN FLIGHT</span>
      </span>

      {/* Les immats en vol : un tap centre la carte. C'est le seul geste utile depuis ce bandeau. */}
      {inFlight.map(ac => {
        const p = posOf(ac)
        return (
          <button key={ident(ac)} type="button" className="ak-focus" disabled={!p}
            onClick={() => p && onLocate?.({ ...p, zoom: 12 })}
            title={p ? `Show ${ident(ac)} on the map` : `${ident(ac)}: no position yet`}
            style={{
              ...monoStyle(12, p ? T.ink : T.graphite), fontWeight: 500, flexShrink: 0,
              background: 'none', border: 'none', borderBottom: `1px solid ${p ? T.ink : 'transparent'}`,
              padding: 0, cursor: p ? 'pointer' : 'default',
            }}>{ident(ac)}</button>
        )
      })}

      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
        {dot(T.etch)}
        <span style={{ ...monoStyle(12, T.ink), fontWeight: 500 }}>{onGround.length}</span>
        <span style={{ ...monoStyle(11, T.graphite) }}>ON GROUND</span>
      </span>

      {noSignal.length > 0 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          {dot(T.amber)}
          <span style={{ ...monoStyle(12, T.ink), fontWeight: 500 }}>{noSignal.length}</span>
          <span style={{ ...monoStyle(11, T.graphite) }}>NO SIGNAL</span>
        </span>
      )}
    </div>
  )
}
