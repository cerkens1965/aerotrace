// ─── Photo avion web (planespotters.net) — partagé AdminPage (fiche) + AerotraceMap (popup) ───
// API publique https://api.planespotters.net/pub/photos/{hex|reg}/… : gratuite, CORS ouvert,
// hotlink des vignettes autorisé À CONDITION d'afficher le crédit photographe + lien vers la
// page photo (leurs conditions). Fetch par ICAO24 d'abord (fiable), fallback immatriculation.
// Cache localStorage 7 j (clé psphoto:<hex|reg>) → pas de spam API.
const PS_CACHE_MS     = 7 * 24 * 3600 * 1000   // photo trouvée : 7 j
const PS_NEG_CACHE_MS = 24 * 3600 * 1000       // rien trouvé : 24 h (une photo peut être ajoutée)

// (2026-08-31) Nos immats sont stockées SANS tiret (OOI44, FJVUD) mais planespotters indexe la
// forme OFFICIELLE (OO-I44, F-JVUD) — vérifié : F-JVUD trouvé, FJVUD non. On essaie donc les
// variantes : brute, préfixe 2 lettres (OO-I44, belge/allemand…), préfixe 1 lettre (F-JVUD).
const regVariants = (reg) => {
  if (!reg) return []
  const r = reg.trim().toUpperCase()
  const out = [r]
  if (!r.includes('-') && r.length >= 4) {
    out.push(`${r.slice(0, 2)}-${r.slice(2)}`)
    out.push(`${r.slice(0, 1)}-${r.slice(1)}`)
  }
  return out
}

export async function fetchWebPhoto({ hex, reg }) {
  const key = `psphoto2:${(hex || reg || '').toLowerCase()}`   // v2 : invalide les null cachés v1
  if (!hex && !reg) return null
  try {
    const c = JSON.parse(localStorage.getItem(key) || 'null')
    if (c && Date.now() - c.at < (c.v ? PS_CACHE_MS : PS_NEG_CACHE_MS)) return c.v
  } catch { /* cache illisible → refetch */ }
  let v = null
  for (const path of [hex && `hex/${hex.toLowerCase()}`,
                      ...regVariants(reg).map(r => `reg/${encodeURIComponent(r)}`)].filter(Boolean)) {
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
