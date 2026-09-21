import { Button } from 'dashboard'

const onInk = { background: '#141414', padding: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' as const }
const row = { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' as const }

export const Variants = () => (
  <div style={row}>
    <Button variant="primary">Open Loop</Button>
    <Button variant="secondary">Edit</Button>
    <Button variant="ghost">Back to logbook</Button>
    <Button variant="danger">Archive</Button>
  </div>
)

export const WithIcons = () => (
  <div style={row}>
    <Button variant="secondary" icon="play">Open Loop</Button>
    <Button variant="secondary" icon="upload">Import CSV</Button>
    <Button variant="ghost" icon="back">Back to logbook</Button>
    <Button variant="secondary" icon="map" size="sm">Show on map</Button>
  </div>
)

export const Sizes = () => (
  <div style={row}>
    <Button variant="primary" size="md">Push to unit</Button>
    <Button variant="primary" size="sm">Push to unit</Button>
    <Button variant="secondary" size="sm" icon="edit">Edit</Button>
  </div>
)

export const States = () => (
  <div style={row}>
    <Button variant="primary" disabled>Saving…</Button>
    <Button variant="danger" confirm="Delete forever?">Purge</Button>
  </div>
)

export const OnInk = () => (
  <div style={onInk}>
    <Button variant="primary" onInk>Continue with Google</Button>
    <Button variant="secondary" onInk>Sign out</Button>
    <Button variant="secondary" onInk icon="map" size="sm">Map</Button>
  </div>
)
