import { Skeleton } from 'dashboard'

export const Card = () => (
  <div style={{ background: '#FFFFFF', border: '1px solid #DDD9D2', borderRadius: 6, padding: 16, width: 280, display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Skeleton width={90} height={10} />
    <Skeleton width={160} height={28} radius={4} />
    <Skeleton width="70%" height={10} />
  </div>
)

export const Lines = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: 360 }}>
    <Skeleton height={12} /><Skeleton height={12} width="85%" /><Skeleton height={12} width="60%" />
  </div>
)

export const Tones = () => (
  <div style={{ display: 'flex', gap: 12, background: '#FFFFFF', padding: 12 }}>
    <Skeleton width={120} height={40} tone="rule" radius={6} />
    <Skeleton width={120} height={40} tone="paper" radius={6} />
  </div>
)
