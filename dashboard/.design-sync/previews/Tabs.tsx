import { useState } from 'react'
import { Tabs } from 'dashboard'

export const Logbook = () => {
  const [v, setV] = useState('matrix')
  return <Tabs ariaLabel="Logbook sections" value={v} onChange={setV} tabs={[
    { key: 'mine', label: 'My flights', count: 12 },
    { key: 'pilots', label: 'Pilots', count: 6 },
    { key: 'aircraft', label: 'Aircraft', count: 11 },
    { key: 'matrix', label: 'All flights', count: '3 to assign' },
    { key: 'archived', label: 'Archived', count: 2 },
  ]} />
}

export const Admin = () => {
  const [v, setV] = useState('pilots')
  return <Tabs ariaLabel="Admin sections" value={v} onChange={setV} tabs={[
    { key: 'pilots', label: 'Pilots', count: 6 },
    { key: 'aircraft', label: 'Aircraft', count: 9 },
    { key: 'access', label: 'Access', count: 3 },
  ]} />
}

export const OnInk = () => {
  const [v, setV] = useState('fleet')
  return (
    <div style={{ background: '#141414', padding: 16 }}>
      <Tabs onInk ariaLabel="Update channel" value={v} onChange={setV} tabs={[
        { key: 'same', label: 'Unchanged' }, { key: 'fleet', label: 'Fleet' }, { key: 'dev', label: 'Dev' },
      ]} />
    </div>
  )
}
