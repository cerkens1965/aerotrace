import { Input } from 'dashboard'

const noop = () => {}
const col = { display: 'flex', flexDirection: 'column' as const, gap: 10, width: 280 }

export const States = () => (
  <div style={col}>
    <Input value="" placeholder="Pilot name" onChange={noop} />
    <Input value="Marc Verhoeven" onChange={noop} />
    <Input mono value="4B1A2C" maxLength={6} onChange={noop} />
    <Input value="EBBY" disabled onChange={noop} />
  </div>
)

export const OnInk = () => (
  <div style={{ ...col, background: '#141414', padding: 16 }}>
    <Input onInk value="" placeholder="Name (e.g. ULM Baisy-Thy)" onChange={noop} />
    <Input onInk mono value="EBBY" onChange={noop} />
  </div>
)
