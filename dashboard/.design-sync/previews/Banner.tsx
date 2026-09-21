import { Banner, Button } from 'dashboard'

const col = { display: 'flex', flexDirection: 'column' as const, gap: 12, maxWidth: 640 }

export const Tones = () => (
  <div style={col}>
    <Banner tone="info" title="Archived flights stay readable">
      They are hidden from the lists and totals, but their recordings are kept so they can still be opened in Loop.
    </Banner>
    <Banner tone="caution" title="Fleet unavailable">
      The fleet status could not be refreshed. The last known positions are shown.
    </Banner>
    <Banner tone="ok">3 archived flights purged with their recordings.</Banner>
  </div>
)

export const WithRetry = () => (
  <div style={col}>
    <Banner tone="caution" title="Traffic unavailable" onRetry={() => {}}>
      SafeSky did not answer. Retrying automatically every 3 seconds.
    </Banner>
  </div>
)

export const WithActions = () => (
  <div style={col}>
    <Banner tone="caution" title="Purge FJFVB · 21 Sep 2026?"
      action={<div style={{ display: 'flex', gap: 8 }}><Button size="sm">Cancel</Button><Button size="sm" variant="primary">Delete permanently</Button></div>}>
      The flight record and its recordings (flight track CSV and LTE log) will be deleted permanently.
    </Banner>
  </div>
)
