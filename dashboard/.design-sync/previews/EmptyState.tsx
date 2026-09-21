import { EmptyState, Button } from 'dashboard'

const box = { background: '#FFFFFF', border: '1px solid #DDD9D2', borderRadius: 6, maxWidth: 560 }

export const WithAction = () => (
  <div style={box}><EmptyState text="No pilots yet." actionLabel="New pilot" onAction={() => {}} /></div>
)

export const TextOnly = () => (
  <div style={box}><EmptyState text="No aircraft in flight." /></div>
)

export const CustomAction = () => (
  <div style={box}>
    <EmptyState text="Choose a flight in the logbook." action={<Button size="sm" icon="list">Open logbook</Button>} />
  </div>
)
