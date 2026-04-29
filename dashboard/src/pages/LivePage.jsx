import AerotraceMap from '../components/map/AerotraceMap'

/**
 * Page LIVE — carte SafeSky + espaces aériens
 * Wrapper pur : ne touche pas à AerotraceMap
 */
export default function LivePage() {
  return (
    <div style={{ width: '100%', height: '100%' }}>
      <AerotraceMap />
    </div>
  )
}
