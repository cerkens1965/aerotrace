import { Toggle } from 'dashboard'

const noop = () => {}

export const Segmented = () => (
  <div style={{ display: 'flex', gap: 6 }}>
    <Toggle active onClick={noop}>Club</Toggle>
    <Toggle onClick={noop}>Owner</Toggle>
  </div>
)

export const Ratings = () => (
  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
    <Toggle mono active onClick={noop}>ULM</Toggle>
    <Toggle mono active onClick={noop}>LAPL</Toggle>
    <Toggle mono onClick={noop}>PPL</Toggle>
    <Toggle mono disabled onClick={noop}>FI</Toggle>
  </div>
)
