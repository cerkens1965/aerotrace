// ─── Photo avion web (planespotters.net) — partagé AdminPage (fiche) + AerotraceMap (popup) ───
// API publique https://api.planespotters.net/pub/photos/{hex|reg}/… : gratuite, CORS ouvert,
// hotlink des vignettes autorisé À CONDITION d'afficher le crédit photographe + lien vers la
// page photo (leurs conditions). Fetch par ICAO24 d'abord (fiable), fallback immatriculation.
// Cache localStorage 7 j (clé psphoto:<hex|reg>) → pas de spam API.
const PS_CACHE_MS = 7 * 24 * 3600 * 1000
export async function fetchWebPhoto({ hex, reg }) {
  const key = `psphoto:${(hex || reg || '').toLowerCase()}`
  if (!hex && !reg) return null
  try {
    const c = JSON.parse(localStorage.getItem(key) || 'null')
    if (c && Date.now() - c.at < PS_CACHE_MS) return c.v
  } catch { /* cache illisible → refetch */ }
  let v = null
  for (const path of [hex && `hex/${hex.toLowerCase()}`, reg && `reg/${encodeURIComponent(reg)}`].filter(Boolean)) {
    try {
      const r = await fetch(`https://api.planespotters.net/pub/photos/${path}`)
      if (!r.ok) continue
      const ph = (await r.json())?.photos?.[0]
      if (ph) {
        v = { url: ph.thumbnail_large?.src || ph.thumbnail?.src || '', credit: ph.photographer || '', link: ph.link || '' }
        if (v.url) break
        v = null
      }
    } catch { /* réseau/CORS → essai suivant */ }
  }
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), v })) } catch { /* quota plein */ }
  return v
}
