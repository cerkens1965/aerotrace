import { AirKiLockup } from 'dashboard'

export const Sidebar = () => <AirKiLockup size={22} />

export const WithBaseline = () => <AirKiLockup size={64} baseline />

export const OnInk = () => (
  <div style={{ background: '#141414', padding: 28 }}><AirKiLockup size={64} color="#FFFFFF" baseline /></div>
)
