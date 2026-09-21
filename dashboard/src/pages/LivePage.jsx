import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import AerotraceMap from '../components/map/AerotraceMap'
import FleetStrip from '../components/map/FleetStrip'
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
          topCenter={clubId ? <FleetStrip {...fleetState} onLocate={locate} /> : null}
        />
      </div>
      {clubId && (
        <LiveInFlightPanel
          inFlight={fleetState.inFlight} owners={owners}
          loading={fleetState.loading} error={fleetState.error} updatedAt={fleetState.updatedAt}
          trafficDown={trafficDown} open={panelOpen} onToggle={togglePanel} onLocate={locate}
        />
      )}
    </div>
  )
}
