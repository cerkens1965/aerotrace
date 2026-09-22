// Tri alphabétique des listes de choix (22/09, demande Christophe : pilotes, instructeurs, avions, types).
// Ignore casse et accents ; les entrées « vides » (value '' : « All pilots », « Select owner… ») restent en tête.
const coll = new Intl.Collator('en', { sensitivity: 'base', numeric: true })
export const byLabel = (a, b) => coll.compare(String(a.label ?? ''), String(b.label ?? ''))
export function sortOptions(options) {
  const head = options.filter(o => o.value === '')
  return [...head, ...options.filter(o => o.value !== '').sort(byLabel)]
}
export const compareText = (a, b) => coll.compare(String(a ?? ''), String(b ?? ''))
