import { AirKiMark } from 'dashboard'

const row = { display: 'flex', gap: 24, alignItems: 'center' }

export const Duo = () => (
  <div style={row}><AirKiMark size={24} /><AirKiMark size={48} /><AirKiMark size={96} /></div>
)

export const Reverse = () => (
  <div style={{ ...row, background: '#141414', padding: 20 }}>
    <AirKiMark size={48} color="#FFFFFF" /><AirKiMark size={96} color="#FFFFFF" />
  </div>
)

export const Mono = () => (
  <div style={row}>
    <AirKiMark variant="mono" size={48} />
    <div style={{ background: '#F5A623', padding: 12 }}><AirKiMark variant="mono" size={48} /></div>
  </div>
)
