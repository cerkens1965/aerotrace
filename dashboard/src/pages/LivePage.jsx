import { useLocation } from 'react-router-dom'
import AerotraceMap from '../components/map/AerotraceMap'

export default function LivePage() {
  const { state } = useLocation()
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <AerotraceMap flyTo={state?.flyTo ?? null} />
    </div>
  )
}
