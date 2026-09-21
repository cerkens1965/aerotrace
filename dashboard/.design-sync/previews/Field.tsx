import { Field, Input, Select } from 'dashboard'

const noop = () => {}
const grid = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, width: 440 }

export const AircraftForm = () => (
  <div style={grid}>
    <Field label="REGISTRATION"><Input mono value="OO-ABC" onChange={noop} /></Field>
    <Field label="CALL SIGN" hint="Shown on the live map."><Input mono value="FJFVB" onChange={noop} /></Field>
    <Field label="TYPE (ICAO)"><Input mono value="A211" onChange={noop} /></Field>
    <Field label="OWNERSHIP">
      <Select value="club" onChange={noop} options={[{ value: 'club', label: 'Club aircraft' }, { value: 'owner', label: 'Private owner' }]} />
    </Field>
  </div>
)

export const OnInk = () => (
  <div style={{ background: '#141414', padding: 16, width: 300 }}>
    <Field onInk label="CLUB CODE" hint="Locked once the club exists.">
      <Input onInk mono value="EBBY-01" onChange={noop} />
    </Field>
  </div>
)
