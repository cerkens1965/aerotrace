import { Chip } from 'dashboard'

const row = { display: 'flex', gap: 8, flexWrap: 'wrap' as const, alignItems: 'center' }

export const Variants = () => (
  <div style={row}>
    <Chip>STUDENT</Chip>
    <Chip strong>FI</Chip>
    <Chip>CLUB</Chip>
    <Chip>OWNER</Chip>
    <Chip muted>ARCHIVED</Chip>
  </div>
)

export const WithStatus = () => (
  <div style={row}>
    <Chip tone="ok">AKC 214</Chip>
    <Chip tone="caution" title="Update available: v214">→ v214</Chip>
    <Chip muted>← v306 dev</Chip>
  </div>
)

export const OnInk = () => (
  <div style={{ ...row, background: '#141414', padding: 16 }}>
    <Chip onInk>CLUB</Chip>
    <Chip onInk strong>OWNER</Chip>
    <Chip onInk tone="ok">LIVE</Chip>
  </div>
)
