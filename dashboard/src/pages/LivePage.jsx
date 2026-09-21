import { useState } from 'react'
import { useLocation } from 'react-router-dom'
import AerotraceMap from '../components/map/AerotraceMap'
import FleetStrip from '../components/map/FleetStrip'
import { useClub } from '../contexts/ClubContext'

// (21/09) Live = carte + bandeau « flotte » (FleetStrip, même source que In flight).
// Un clic sur une immatriculation du bandeau centre la carte (flyTo, nouvel objet à chaque clic).
export default function LivePage() {
  const { state } = useLocation()
  const { clubId } = useClub()
  const [focus, setFocus] = useState(null)
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <AerotraceMap flyTo={focus ?? state?.flyTo ?? null} />
      <FleetStrip clubId={clubId} onLocate={(p) => setFocus({ ...p, _t: Date.now() })} />
    </div>
  )
}
