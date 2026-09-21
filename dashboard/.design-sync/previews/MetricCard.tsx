import { MetricCard } from 'dashboard'

const grid = { display: 'grid', gridTemplateColumns: 'repeat(3, 200px)', gap: 10 }

export const LiveFleet = () => (
  <div style={grid}>
    <MetricCard label="FJFVB · ALT FT" value="3450" status={{ tone: 'ok', text: 'In flight' }} />
    <MetricCard label="FJVUD · GS KT" value="104" status={{ tone: 'ok', text: 'In flight' }} />
    <MetricCard label="OOH14 · LOGGED H" value="1842.6" status={{ tone: 'caution', text: 'On ground' }} />
  </div>
)

export const LogbookTotals = () => (
  <div style={grid}>
    <MetricCard label="FLIGHTS · SEP" value="38" />
    <MetricCard label="HOURS · SEP" value="41:20" />
    <MetricCard label="TO VALIDATE" value="3" status={{ tone: 'caution', text: 'Instructor sign-off' }} />
  </div>
)

export const MissingValue = () => (
  <div style={grid}>
    <MetricCard label="OOI15 · ALT FT" value={null} status={{ tone: 'off', text: 'Not reporting' }} />
    <MetricCard label="DATA · SEP" value="412" unit="MB" status={{ tone: 'ok', text: '41 % of pool' }} />
  </div>
)
