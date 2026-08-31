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
        v = { url: ph.thumbnail_large?.src || ph.thumbnail?.src || '', credit: ph.photographer || '', link: ph.link || '', site: 'planespotters.net' }
        if (v.url) break
        v = null
      }
    } catch { /* réseau/CORS → essai suivant */ }
  }
  // (2026-08-31, demande Christophe « va voir dans jetphotos ») JetPhotos n'a PAS d'API publique
  // (banque photo FR24, scraping interdit) → repli AIRPORT-DATA.COM via notre proxy Cloud Function
  // /api/acphoto (pas de CORS chez eux). Couverture ULM belges excellente (OO-I44/I43/H63/I35).
  if (!v) {
    for (const r of regVariants(reg)) {
      try {
        const j = await (await fetch(`/api/acphoto?r=${encodeURIComponent(r)}`)).json()
        if (j?.photo?.url) { v = { ...j.photo, site: 'airport-data.com' }; break }
      } catch { /* proxy KO → variante suivante */ }
    }
  }
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), v })) } catch { /* quota plein */ }
  return v
}

// ─── (2026-08-31) Immat → HEX transpondeur (Mode S) — hexdb.io puis adsbdb.com ────────────────
// Les deux sont gratuites et CORS ouvert (vérifié). Couverture partielle : les OO-Hxx/OO-I35 y
// sont, les OO-I4x et indicatifs français F-Jxxx non (→ saisie manuelle via FR24). Les valeurs
// trouvées ont été validées identiques aux relevés FR24 de Christophe (44A3FB/44A3CA/44A7DF).
const RH_NEG_MS = 10 * 60 * 1000   // pas trouvé : 10 min seulement (la source LIVE peut répondre au prochain vol)
export async function fetchHexForReg(reg) {
  if (!reg) return null
  const key = `reghex:${reg.trim().toLowerCase()}`
  try {
    const c = JSON.parse(localStorage.getItem(key) || 'null')
    if (c && Date.now() - c.at < (c.v ? PS_CACHE_MS : RH_NEG_MS)) return c.v
  } catch { /* cache illisible → refetch */ }
  let v = null
  const isHex6 = (x) => /^[0-9A-F]{6}$/i.test(x || '')
  for (const r of regVariants(reg)) {
    try {   // hexdb.io : texte brut ("44A3FB" ou "n/a")
      const t = (await (await fetch(`https://hexdb.io/reg-hex?reg=${encodeURIComponent(r)}`)).text()).trim()
      if (isHex6(t)) { v = { hex: t.toUpperCase(), source: 'hexdb.io', reg: r }; break }
    } catch { /* réseau → source suivante */ }
    try {   // adsbdb.com : JSON {response:{aircraft:{mode_s}}}
      const j = await (await fetch(`https://api.adsbdb.com/v0/aircraft/${encodeURIComponent(r)}`)).json()
      const ms = j?.response?.aircraft?.mode_s
      if (isHex6(ms)) { v = { hex: ms.toUpperCase(), source: 'adsbdb.com', reg: r }; break }
    } catch { /* réseau → variante suivante */ }
  }
  // (2026-08-31, idée Christophe « base-toi sur l'indicatif radio ») 3e source : LIVE adsb.lol via
  // notre proxy /api/hexlive — le transpondeur émet son Flight ID (« FJVUD ») quand il vole → seul
  // moyen pour les indicatifs F-J absents des registres. Forme BRUTE d'abord (l'ident n'a pas de
  // tiret), puis variantes. Ne répond que si l'avion émet à cet instant.
  if (!v) {
    for (const r of [reg.trim().toUpperCase(), ...regVariants(reg).slice(1)]) {
      try {
        const j = await (await fetch(`/api/hexlive?q=${encodeURIComponent(r)}`)).json()
        if (j?.hex) { v = { hex: j.hex, source: 'adsb.lol (LIVE — avion en émission)', reg: r }; break }
      } catch { /* proxy KO → variante suivante */ }
    }
  }
  try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), v })) } catch { /* quota */ }
  return v
}
