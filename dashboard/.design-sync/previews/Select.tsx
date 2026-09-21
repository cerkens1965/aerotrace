import { Select } from 'dashboard'

const noop = () => {}
const pilots = [
  { value: 'mv', label: 'Marc Verhoeven' },
  { value: 'ld', label: 'Léa Dubois' },
  { value: 'al', label: 'Antoine Lefèvre' },
]

export const Choice = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: 280 }}>
    <Select value="" placeholder="Choose a pilot…" options={pilots} onChange={noop} />
    <Select value="ld" options={pilots} onChange={noop} />
  </div>
)

export const OnInk = () => (
  <div style={{ background: '#141414', padding: 16, width: 280 }}>
    <Select onInk value="ebby" options={[{ value: 'ebby', label: 'ULM Baisy-Thy · EBBY' }, { value: 'ebzw', label: 'Genk Zwartberg · EBZW' }]} onChange={noop} />
  </div>
)
