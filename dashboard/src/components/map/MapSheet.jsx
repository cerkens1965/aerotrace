// MapSheet — feuille de contrôles posée SUR la carte (Claude Design, « Live on iPad/iPhone »,
// 23/09/2026). Elle remplace, sous 1024 px, les panneaux flottants LAYERS et le panneau
// latéral des vols : sur un écran de 390 px ils couvraient plus de la moitié de la carte,
// ouverts d'entrée, alors que la carte EST la page.
//
// Grammaire du design :
//   · téléphone — feuille montant du bas, trois crans : repliée (on ne voit que le bandeau
//     flotte), moitié (380 px), pleine. Poignée en haut, deux onglets Fleet / Layers.
//   · tablette  — la même feuille devient un panneau ancré en bas à droite, 360 px de large,
//     posé au-dessus du bandeau : la moitié haute de la carte et le coin haut-gauche restent
//     libres (c'est là que se porte le regard, et là que la main masque l'écran).
//
// Surfaces : LAVIS papier à 18 % + flou 8 px, filet 1 px — règle 8b, rien d'opaque ne se pose
// sur une carte. Le seul panneau encre autorisé est la bulle d'un avion.
import { useState, useEffect, useRef } from 'react'
import { T } from '../ui'
import Icon from '../ui/Icon'

// Lavis des surfaces posées sur la carte — papier 18 % + flou 8 px, filet 1 px (règle 8b).
// Volontairement NON exporté : un module de composants qui exporte aussi des constantes casse
// le rafraîchissement à chaud de Vite.
const WASH = {
  background: 'rgba(244,242,237,0.18)',
  backdropFilter: 'blur(8px)',
  WebkitBackdropFilter: 'blur(8px)',
  border: '1px solid rgba(20,20,20,0.28)',
}

// Bouton de carte — carré de 44 px sur lavis. 44 px est la cible tactile minimale : plusieurs
// de nos interrupteurs faisaient 20 px, inatteignables au pouce en mouvement.
export function MapControl({ icon, label, active, onClick }) {
  return (
    <button type="button" className="ak-focus" onClick={onClick} title={label} aria-label={label}
      aria-pressed={active === undefined ? undefined : !!active}
      style={{
        width: 44, height: 44, flex: '0 0 44px', display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: 6, cursor: 'pointer', color: T.ink,
        ...WASH,
        background: active ? 'rgba(244,242,237,0.72)' : WASH.background,
      }}>
      <Icon name={icon} size={20} />
    </button>
  )
}

const DETENT = { closed: 0, half: 380 }

export default function MapSheet({ open, onOpenChange, tab, onTabChange, tabs, children, isPhone, bottomOffset = 0 }) {
  const [full, setFull] = useState(false)
  const startY = useRef(null)
  useEffect(() => { if (!open) setFull(false) }, [open])

  // Glisser la poignée : vers le haut = plein écran, vers le bas = cran suivant puis fermeture.
  const onPointerDown = (e) => { startY.current = e.clientY }
  const onPointerUp = (e) => {
    if (startY.current == null) return
    const dy = e.clientY - startY.current
    startY.current = null
    if (dy < -40) setFull(true)
    else if (dy > 40) { if (full) setFull(false); else onOpenChange(false) }
  }

  if (!open) return null

  const phoneStyle = {
    position: 'absolute', left: 0, right: 0, bottom: bottomOffset, zIndex: 20,
    height: full ? `calc(100% - ${bottomOffset}px - 56px)` : DETENT.half,
    borderRadius: '12px 12px 0 0',
    display: 'flex', flexDirection: 'column',
  }
  // Tablette : panneau ancré en bas à droite, la carte garde sa moitié haute et son coin gauche.
  const tabletStyle = {
    position: 'absolute', right: 16, bottom: bottomOffset + 16, zIndex: 20,
    width: 360, maxHeight: 'min(600px, calc(100% - 120px))',
    borderRadius: 8,
    display: 'flex', flexDirection: 'column',
  }

  return (
    <div style={{ ...WASH, ...(isPhone ? phoneStyle : tabletStyle), overflow: 'hidden' }}>
      {isPhone && (
        <div onPointerDown={onPointerDown} onPointerUp={onPointerUp}
          style={{ padding: '8px 0 4px', display: 'flex', justifyContent: 'center', cursor: 'grab', touchAction: 'none' }}>
          <div style={{ width: 36, height: 4, borderRadius: 999, background: 'rgba(20,20,20,0.28)' }} />
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: isPhone ? '6px 12px 10px 16px' : '12px 12px 10px 16px' }}>
        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: `repeat(${tabs.length}, 1fr)`, gap: 6 }}>
          {tabs.map(t => (
            <button key={t.key} type="button" className="ak-focus" onClick={() => onTabChange(t.key)}
              aria-pressed={tab === t.key}
              style={{
                height: 44, borderRadius: 4, cursor: 'pointer', minWidth: 0,
                border: `1px solid ${tab === t.key ? T.ink : 'rgba(20,20,20,0.28)'}`,
                background: tab === t.key ? T.ink : 'transparent',
                color: tab === t.key ? T.white : T.ink,
                fontFamily: T.mono, fontSize: 11, letterSpacing: '0.04em',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{t.label}</button>
          ))}
        </div>
        <button type="button" className="ak-focus" onClick={() => onOpenChange(false)} title="Close" aria-label="Close"
          style={{ width: 44, height: 44, flex: '0 0 44px', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: '1px solid rgba(20,20,20,0.28)', borderRadius: 4, cursor: 'pointer', color: T.ink }}>
          <Icon name="close" size={18} />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 16px 20px' }}>
        {children}
      </div>
    </div>
  )
}
