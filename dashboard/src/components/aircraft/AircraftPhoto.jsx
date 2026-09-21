// AircraftPhoto — vignette photo d'un avion (2026-09-21), partagée Admin / In flight.
// Ordre : photo enregistrée dans la fiche (photoUrl) → photo web auto (planespotters, cache 7 j, affichage seul,
// rien n'est écrit en base) → à défaut, le type OACI dans un cadre. DS : cadre 1 px, radius 4, aucune ombre,
// crédit photo au survol. onInk = cadre et repli adaptés au fond encre.
import { useEffect, useState } from 'react'
import { fetchWebPhoto } from '../../lib/webphoto'
import { T, monoStyle } from '../ui'
import { photoFrame } from './photoFrame'

export default function AircraftPhoto({ ac, width = 56, height = 42, onInk = false }) {
  const [webPhoto, setWebPhoto] = useState(null)
  useEffect(() => {
    if (ac.photoUrl || (!ac.icao24 && !ac.callSign)) return undefined
    let on = true
    fetchWebPhoto({ hex: ac.icao24, reg: ac.callSign }).then(v => { if (on && v?.url) setWebPhoto(v) })
    return () => { on = false }
  }, [ac.photoUrl, ac.icao24, ac.callSign])
  const url = ac.photoUrl || webPhoto?.url
  const title = ac.photoUrl
    ? (ac.photoSource ? `© ${ac.photoCredit || '?'} · ${ac.photoSource}` : '')
    : (webPhoto ? `© ${webPhoto.credit || '?'} · ${webPhoto.site || 'planespotters.net'}` : '')
  const box = { width, height, borderRadius: T.radius.sm, flexShrink: 0, display: 'block',
                border: `1px solid ${onInk ? T.ruleDark : T.rule}` }
  return url ? (
    <div title={title} style={{ ...box, overflow: 'hidden' }}>
      <img src={url} alt="" loading="lazy"
        style={{ ...photoFrame(ac.photoUrl ? ac : {}), filter: ac.archived ? 'grayscale(1)' : undefined }} />
    </div>
  ) : (
    <div style={{ ...box, background: onInk ? '#1C1C1A' : T.paper, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  ...monoStyle(10, onInk ? T.mutedDark : T.etch) }}>
      {ac.typeDesig || '—'}
    </div>
  )
}
