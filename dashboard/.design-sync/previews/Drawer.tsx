import { Drawer, Button, StatusDot } from 'dashboard'

const label = { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', color: '#8D9096', marginBottom: 6 }
const value = { fontFamily: 'var(--font-mono)', fontSize: 14, color: '#141414' }
const section = { padding: '14px 0', borderBottom: '1px solid #DDD9D2' }

export const UnitConfig = () => (
  <div style={{ height: 520, background: '#F4F2ED' }}>
    <Drawer open onClose={() => {}} closeOnOverlay={false} title="Unit CE276D" subtitle="AKC X.1.214 · s3dev · last seen 2 min ago"
      footer={<div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}><Button>Cancel</Button><Button variant="primary">Push to unit</Button></div>}>
      <div style={section}><div style={label}>IDENTITY</div><div style={value}>FJFVB · VL3 · 38ED5C</div></div>
      <div style={section}><div style={label}>UPDATE CHANNEL</div><StatusDot tone="info" text="DEV (S3DEV)" /></div>
      <div style={section}>
        <div style={label}>KNOWN WIFI NETWORKS</div>
        <div style={{ ...value, display: 'flex', justifyContent: 'space-between' }}><span>1. Proximus-Home-994542 · connected</span><span style={{ color: '#4A4A46', fontFamily: 'var(--font-sans)', fontSize: 12 }}>pilot</span></div>
        <div style={{ ...value, display: 'flex', justifyContent: 'space-between', marginTop: 6 }}><span>2. MyIOTWiFi</span><span style={{ color: '#4A4A46', fontFamily: 'var(--font-sans)', fontSize: 12 }}>dashboard</span></div>
      </div>
    </Drawer>
  </div>
)
