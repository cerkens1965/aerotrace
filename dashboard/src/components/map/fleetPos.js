// Position connue d'un avion de la flotte (useFleet) : SafeSky / balise d'abord, sinon dernier statut FDR.
export const posOf = (a) => {
  const l = a.liveData, f = a.fdrData
  if (l?.lat != null && l?.lon != null) return { lat: l.lat, lon: l.lon }
  if (f?.lat != null && f?.lon != null) return { lat: f.lat, lon: f.lon }
  return null
}
