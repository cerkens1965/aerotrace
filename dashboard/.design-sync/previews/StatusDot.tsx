import { StatusDot } from 'dashboard'

const col = { display: 'flex', flexDirection: 'column' as const, gap: 10 }

export const Tones = () => (
  <div style={col}>
    <StatusDot tone="ok" text="IN FLIGHT" />
    <StatusDot tone="caution" text="LTE LOST" />
    <StatusDot tone="info" text="SYNCING" />
    <StatusDot tone="off" text="GROUNDED" />
  </div>
)

export const OnInk = () => (
  <div style={{ ...col, background: '#141414', padding: 16 }}>
    <StatusDot tone="ok" text="LIVE" onInk />
    <StatusDot tone="caution" text="NO RECENT SIGNAL" onInk />
    <StatusDot tone="off" text="PARKED" onInk />
  </div>
)

export const DotOnly = () => (
  <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
    <StatusDot tone="ok" /><StatusDot tone="caution" /><StatusDot tone="off" /><StatusDot tone="ok" size={12} />
  </div>
)
