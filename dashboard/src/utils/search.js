// Recherche texte commune aux pages (22/09) : insensible à la casse ET aux accents, tous les mots doivent
// être présents (ordre libre) dans l'un des champs passés. Sortie de AdminPage pour Logbook / Fleet.
export const fold = (x) => String(x ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
export function matches(q, ...fields) {
  const n = fold(q).trim()
  if (!n) return true
  const hay = fields.map(fold).join(' ')
  return n.split(/\s+/).every(w => hay.includes(w))
}
