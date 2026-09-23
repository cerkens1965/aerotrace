import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import AerotraceMap from '../components/map/AerotraceMap'
import useBreakpoint from '../hooks/useBreakpoint'
import FleetStrip from '../components/map/FleetStrip'
import FleetStripWash from '../components/map/FleetStripWash'
import LiveInFlightPanel from '../components/map/LiveInFlightPanel'
import useFleet from '../hooks/useFleet'
import useOwnerNames from '../hooks/useOwnerNames'
import { useClub } from '../contexts/ClubContext'

// (22/09) Live d'après Claude Design « Live » : carte (Layers en haut à gauche, bandeau FLEET centré,
// légende en bas à droite, bannière si le trafic tombe) + panneau In flight 320 px à droite, repliable.
// UN SEUL useFleet pour le bandeau et le panneau (avant : le bandeau pollait seul).
// Clic sur une immatriculation (bandeau ou carte du panneau) → flyTo, nouvel objet à chaque clic.
const PANEL_KEY = 'ak_live_panel'
const readPanel = () => {
  try { const v = localStorage.getItem(PANEL_KEY); if (v != null) return v === '1' } catch { /* stockage indisponible */ }
  return typeof window === 'undefined' || window.innerWidth >= 1100
}

export default function LivePage() {
  const { isCompact } = useBreakpoint()
  const { state } = useLocation()
  const { clubId } = useClub()
  const fleetState = useFleet(clubId)
  const owners = useOwnerNames(clubId)
  const [focus, setFocus] = useState(null)
  const [trafficDown, setTrafficDown] = useState(false)
  const [panelOpen, setPanelOpen] = useState(readPanel)
  const locate = (p) => setFocus({ ...p, _t: Date.now() })
  const togglePanel = () => setPanelOpen(o => {
    try { localStorage.setItem(PANEL_KEY, o ? '0' : '1') } catch { /* ignore */ }
    return !o
  })

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%', minHeight: 0 }}>
      <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <AerotraceMap
          flyTo={focus ?? state?.flyTo ?? null}
          onTrafficState={setTrafficDown}
          /* (23/09) Le bandeau de bureau est un panneau ENCRE sur deux lignes : sur téléphone
             il masquait la carte et le zoom. Sous 1024 px on sert la version d'UNE ligne en
             lavis prévue par le design — mêmes comptes, mêmes immats tapables. */
          topCenter={!clubId ? null : isCompact
            ? <FleetStripWash inFlight={fleetState.inFlight} onGround={fleetState.grounded}
                noSignal={fleetState.unknown} onLocate={locate} />
            : <FleetStrip {...fleetState} onLocate={locate} />}
          /* (23/09, Claude Design) Sous 1024 px le panneau latéral des vols n'est plus à côté
             de la carte : il devient l'onglet Fleet de la feuille. Même composant, même
             données — c'est sa place qui change, pas son contenu. */
          compactFleet={clubId ? (
            <LiveInFlightPanel
              inFlight={fleetState.inFlight} owners={owners}
              loading={fleetState.loading} error={fleetState.error} updatedAt={fleetState.updatedAt}
              trafficDown={trafficDown} open onToggle={null} onLocate={locate} embedded
            />
          ) : null}
        />
      </div>
      {clubId && !isCompact && (
        <LiveInFlightPanel
          inFlight={fleetState.inFlight} owners={owners}
          loading={fleetState.loading} error={fleetState.error} updatedAt={fleetState.updatedAt}
          trafficDown={trafficDown} open={panelOpen} onToggle={togglePanel} onLocate={locate}
        />
      )}
    </div>
  )
}
