import { Icon } from 'dashboard'

const names = ['map','list','plane','play','back','chevron-right','close','upload','download','edit','archive','check','warning','refresh','user','settings','search','filter','external','wifi'] as const
const cell = { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 6, width: 72, color: '#141414' }
const cap = { fontFamily: 'var(--font-mono)', fontSize: 10, color: '#8D9096' }

export const Set = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 12, maxWidth: 640 }}>
    {names.map(n => <div key={n} style={cell}><Icon name={n} size={20} /><span style={cap}>{n}</span></div>)}
  </div>
)

export const Sizes = () => (
  <div style={{ display: 'flex', gap: 16, alignItems: 'center', color: '#141414' }}>
    <Icon name="plane" size={16} /><Icon name="plane" size={20} /><Icon name="plane" size={24} /><Icon name="plane" size={32} />
  </div>
)

export const OnInk = () => (
  <div style={{ display: 'flex', gap: 16, background: '#141414', padding: 16 }}>
    <Icon name="map" size={20} color="#FFFFFF" /><Icon name="wifi" size={20} color="#FFFFFF" /><Icon name="warning" size={20} color="#9A9A94" />
  </div>
)
