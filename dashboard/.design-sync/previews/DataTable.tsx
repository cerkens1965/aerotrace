import { DataTable, StatusDot, Button, EmptyState } from 'dashboard'

const flights = [
  { id: 'f1', date: '21 Sep 2026 · 14:32 UTC', aircraft: 'FJFVB', route: 'EBBY → EDRA', pilot: 'Christophe Erkens', duration: '01:48', validated: true },
  { id: 'f2', date: '20 Sep 2026 · 09:05 UTC', aircraft: 'OOH14', route: 'EBBY → EBBY', pilot: 'Tristan Fily', duration: '00:42', validated: false },
  { id: 'f3', date: '19 Sep 2026 · 16:20 UTC', aircraft: 'FJVUD', route: 'EBBY → EBNM', pilot: 'Pierre LeParrain', duration: '01:12', validated: true },
]

const columns = [
  { key: 'date', label: 'DATE', mono: true },
  { key: 'aircraft', label: 'AIRCRAFT', mono: true },
  { key: 'route', label: 'ROUTE' },
  { key: 'pilot', label: 'PILOT' },
  { key: 'duration', label: 'DURATION', mono: true, align: 'right' as const },
  { key: 'status', label: 'STATUS', render: (f: any) => <StatusDot tone={f.validated ? 'ok' : 'caution'} text={f.validated ? 'VALIDATED' : 'TO ASSIGN'} /> },
  { key: 'actions', label: '', align: 'right' as const, render: () => <Button size="sm" icon="play">Open Loop</Button> },
]

export const Flights = () => <DataTable columns={columns} rows={flights} />

export const Loading = () => <DataTable columns={columns.slice(0, 5)} rows={[]} loading />

export const Empty = () => (
  <DataTable columns={columns.slice(0, 5)} rows={[]}
    empty={<EmptyState text="No flights yet — flights arrive from the AirKi Core after landing." actionLabel="Import CSV" onAction={() => {}} />} />
)
