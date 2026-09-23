/**
 * SixPack.jsx — Cockpit instruments for AeroTrace REPLAY
 * ADI / Airspeed / Altimeter / VSI / Heading / Turn Coordinator
 */
import { useRef, useEffect } from 'react'
import { T } from './tokens'

// (23/09, Christophe : « meilleure intégration et dessin du six-pack »)
// Le six-pack était le dernier îlot hors charte du dashboard : cadrans BLEU MARINE en dégradé
// radial, arc ROUGE sur l'anémomètre, valeurs écrites en AMBRE — trois règles enfreintes
// (pas de bleu marine, pas de rouge, l'ambre n'est jamais une couleur de texte), plus une
// ombre portée et une bordure blanche de 2 px. Tout est repris sur les jetons :
//   fond encre plat · filet 1 px rule-dark · aiguilles et repères blancs · graduations etch ·
//   chiffres muted-dark · valeur lue en Geist Mono BLANC · ambre réservé au repère « avion ».
const C = {
  face:   T.ink,          // fond de cadran — encre, à plat (les dégradés sont proscrits)
  border: T.ruleDark,     // filet 1 px
  mark:   T.white,        // aiguilles, horizon, repères majeurs
  tick:   T.etch,         // graduations mineures
  num:    T.mutedDark,    // chiffres de cadran
  own:    T.amber,        // repère « avion » (même convention que l'own-ship du radar AKview)
  text:   T.white,        // valeur numérique
  mono:   T.mono,
}

// ─── Canvas instrument base ───────────────────────────────────────────────────
function Instrument({ label, size = 110, children }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <div style={{
        width: size, height: size, borderRadius: '50%',
        background: C.face,
        border: `1px solid ${C.border}`,
        position: 'relative', overflow: 'hidden',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {children}
      </div>
      <span style={{ fontFamily: C.mono, fontSize: 10, fontWeight: 500, letterSpacing: '0.08em', color: C.num }}>
        {label}
      </span>
    </div>
  )
}

// ─── ADI — Attitude Direction Indicator ──────────────────────────────────────
function ADI({ pitch = 0, roll = 0, size = 110 }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const cx = size / 2, cy = size / 2, r = size / 2 - 2

    ctx.clearRect(0, 0, size, size)

    // Clip to circle
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.clip()

    // Rotate for roll
    ctx.translate(cx, cy)
    ctx.rotate((roll * Math.PI) / 180)
    ctx.translate(-cx, -cy)

    // Horizon offset for pitch (2px per degree)
    const pitchOffset = pitch * 2

    // Sky
    ctx.fillStyle = T.ruleDark   // ciel — gris foncé de la palette
    ctx.fillRect(0, 0, size, cy + pitchOffset)

    // Ground
    ctx.fillStyle = T.graphite   // sol — gris chaud, plus clair que le ciel : la ligne d'horizon blanche fait la séparation
    ctx.fillRect(0, cy + pitchOffset, size, size)

    // Horizon line
    ctx.strokeStyle = C.mark
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(0, cy + pitchOffset)
    ctx.lineTo(size, cy + pitchOffset)
    ctx.stroke()

    // Pitch lines
    for (let p = -20; p <= 20; p += 5) {
      if (p === 0) continue
      const y = cy + pitchOffset - p * 2
      const w = p % 10 === 0 ? 24 : 14
      ctx.strokeStyle = C.mark
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(cx - w, y)
      ctx.lineTo(cx + w, y)
      ctx.stroke()
    }

    ctx.restore()

    // Fixed aircraft symbol (amber)
    ctx.strokeStyle = C.own
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx - 20, cy); ctx.lineTo(cx - 8, cy)
    ctx.moveTo(cx - 8, cy); ctx.lineTo(cx - 4, cy + 4)
    ctx.moveTo(cx - 4, cy + 4); ctx.lineTo(cx, cy + 4)
    ctx.moveTo(cx, cy + 4); ctx.lineTo(cx + 4, cy + 4)
    ctx.moveTo(cx + 4, cy + 4); ctx.lineTo(cx + 8, cy)
    ctx.moveTo(cx + 8, cy); ctx.lineTo(cx + 20, cy)
    ctx.stroke()

    // Center dot
    ctx.fillStyle = C.text
    ctx.beginPath()
    ctx.arc(cx, cy, 2, 0, Math.PI * 2)
    ctx.fill()

  }, [pitch, roll, size])

  return <canvas ref={canvasRef} width={size} height={size} style={{ borderRadius: '50%' }} />
}

// ─── Airspeed Indicator ───────────────────────────────────────────────────────
function AirspeedIndicator({ ias = 0, size = 110 }) {
  const kmh = ias * 1.852   // interne kt → cadran/affichage km/h (décision 2026-08-10)
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const cx = size/2, cy = size/2, r = size/2 - 4

    ctx.clearRect(0, 0, size, size)
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI*2)
    ctx.clip()

    // (23/09) ARCS DE PLAGE RETIRÉS. Ils étaient codés en dur (110/220/260/300 km/h, valeurs
    // d'un VL3) et affichés à l'identique pour TOUS les appareils — donc faux dès qu'on relit
    // le vol d'un autre avion — avec en prime un arc ROUGE, proscrit par la charte. Ils
    // reviendront le jour où les limites seront saisies PAR AVION (Vne, Vno, Va depuis le
    // manuel de vol) : c'est l'objet de l'étude de vol à venir.

    // Tick marks
    for (let v = 0; v <= 370; v += 20) {
      const angle = (v/370 * 270 - 225) * Math.PI/180
      const isMajor = v % 40 === 0
      const r1 = r - (isMajor ? 10 : 6)
      ctx.beginPath()
      ctx.moveTo(cx + r1 * Math.cos(angle), cy + r1 * Math.sin(angle))
      ctx.lineTo(cx + (r-6) * Math.cos(angle), cy + (r-6) * Math.sin(angle))
      ctx.strokeStyle = C.mark
      ctx.lineWidth = isMajor ? 1.5 : 1
      ctx.stroke()

      if (isMajor && v > 0) {
        ctx.fillStyle = C.num
        ctx.font = `${size < 100 ? 7 : 8}px monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const tr = r - 18
        ctx.fillText(v, cx + tr * Math.cos(angle), cy + tr * Math.sin(angle))
      }
    }

    // Needle
    const angle = (Math.min(kmh, 370)/370 * 270 - 225) * Math.PI/180
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + (r-8) * Math.cos(angle), cy + (r-8) * Math.sin(angle))
    ctx.strokeStyle = C.mark
    ctx.lineWidth = 2
    ctx.stroke()

    // Center
    ctx.beginPath()
    ctx.arc(cx, cy, 4, 0, Math.PI*2)
    ctx.fillStyle = C.border
    ctx.fill()

    ctx.restore()

    // Digital readout
    ctx.fillStyle = C.text
    ctx.font = `bold ${size < 100 ? 10 : 11}px monospace`
    ctx.textAlign = 'center'
    ctx.fillText(`${Math.round(kmh)}km/h`, cx, cy + 22)
  }, [ias, size])

  return <canvas ref={canvasRef} width={size} height={size} style={{ borderRadius: '50%' }} />
}

// ─── Altimeter ────────────────────────────────────────────────────────────────
function Altimeter({ alt = 0, size = 110 }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const cx = size/2, cy = size/2, r = size/2 - 4

    ctx.clearRect(0, 0, size, size)
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI*2)
    ctx.clip()

    // 100ft needle (short)
    const hundreds = (alt % 1000) / 1000
    const angle100 = (hundreds * 360 - 90) * Math.PI/180
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + (r-14) * Math.cos(angle100), cy + (r-14) * Math.sin(angle100))
    ctx.strokeStyle = C.mark
    ctx.lineWidth = 1.5
    ctx.stroke()

    // Tick marks
    for (let i = 0; i < 10; i++) {
      const angle = (i * 36 - 90) * Math.PI/180
      const isMajor = i % 2 === 0
      ctx.beginPath()
      ctx.moveTo(cx + (r - (isMajor ? 10 : 6)) * Math.cos(angle), cy + (r - (isMajor ? 10 : 6)) * Math.sin(angle))
      ctx.lineTo(cx + (r-3) * Math.cos(angle), cy + (r-3) * Math.sin(angle))
      ctx.strokeStyle = C.mark
      ctx.lineWidth = isMajor ? 1.5 : 1
      ctx.stroke()
      if (isMajor) {
        ctx.fillStyle = C.num
        ctx.font = `${size < 100 ? 7 : 8}px monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const tr = r - 18
        ctx.fillText(i === 0 ? '0' : i*1, cx + tr * Math.cos(angle), cy + tr * Math.sin(angle))
      }
    }

    // 1000ft needle (long)
    const thousands = alt / 10000
    const angle1000 = (thousands * 360 - 90) * Math.PI/180
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + (r-6) * Math.cos(angle1000), cy + (r-6) * Math.sin(angle1000))
    ctx.strokeStyle = C.mark
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(cx, cy, 4, 0, Math.PI*2)
    ctx.fillStyle = C.border
    ctx.fill()
    ctx.restore()

    // Digital
    ctx.fillStyle = C.text
    ctx.font = `bold ${size < 100 ? 10 : 11}px monospace`
    ctx.textAlign = 'center'
    ctx.fillText(`${Math.round(alt)}ft`, cx, cy + 22)
  }, [alt, size])

  return <canvas ref={canvasRef} width={size} height={size} style={{ borderRadius: '50%' }} />
}

// ─── VSI — Vertical Speed ─────────────────────────────────────────────────────
function VSI({ vspd = 0, size = 110 }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const cx = size/2, cy = size/2, r = size/2 - 4

    ctx.clearRect(0, 0, size, size)
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI*2)
    ctx.clip()

    // Scale: -2000 to +2000 fpm, 270° sweep
    const ticks = [-2000,-1000,-500,0,500,1000,2000]
    ticks.forEach(v => {
      const norm = (v + 2000) / 4000
      const angle = (norm * 270 - 225) * Math.PI/180
      const isMajor = v % 1000 === 0
      ctx.beginPath()
      ctx.moveTo(cx + (r - (isMajor ? 10 : 6)) * Math.cos(angle), cy + (r - (isMajor ? 10 : 6)) * Math.sin(angle))
      ctx.lineTo(cx + (r-3) * Math.cos(angle), cy + (r-3) * Math.sin(angle))
      ctx.strokeStyle = C.mark
      ctx.lineWidth = isMajor ? 1.5 : 1
      ctx.stroke()
      if (isMajor) {
        ctx.fillStyle = v === 0 ? C.mark : C.num
        ctx.font = `${size < 100 ? 7 : 8}px monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const tr = r - 18
        ctx.fillText(Math.abs(v/100), cx + tr * Math.cos(angle), cy + tr * Math.sin(angle))
      }
    })

    // Needle
    const clamped = Math.max(-2000, Math.min(2000, vspd))
    const norm = (clamped + 2000) / 4000
    const angle = (norm * 270 - 225) * Math.PI/180
    ctx.beginPath()
    ctx.moveTo(cx, cy)
    ctx.lineTo(cx + (r-6) * Math.cos(angle), cy + (r-6) * Math.sin(angle))
    ctx.strokeStyle = C.mark
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.beginPath()
    ctx.arc(cx, cy, 4, 0, Math.PI*2)
    ctx.fillStyle = C.border
    ctx.fill()
    ctx.restore()

    // Digital
    const color = C.text   // (23/09) plus de vert/rouge selon le sens : le signe se lit déjà, et le rouge est proscrit
    ctx.fillStyle = color
    ctx.font = `bold ${size < 100 ? 10 : 11}px monospace`
    ctx.textAlign = 'center'
    ctx.fillText(`${vspd > 0 ? '+' : ''}${Math.round(vspd)}`, cx, cy + 22)
  }, [vspd, size])

  return <canvas ref={canvasRef} width={size} height={size} style={{ borderRadius: '50%' }} />
}

// ─── Heading Indicator ────────────────────────────────────────────────────────
function HeadingIndicator({ hdg = 0, trk = 0, size = 110 }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const cx = size/2, cy = size/2, r = size/2 - 4

    ctx.clearRect(0, 0, size, size)
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI*2)
    ctx.clip()

    // Rotate compass rose
    ctx.translate(cx, cy)
    ctx.rotate((-hdg * Math.PI) / 180)
    ctx.translate(-cx, -cy)

    const cardinals = ['N','E','S','W']
    for (let i = 0; i < 36; i++) {
      const angle = (i * 10 - 90) * Math.PI/180
      const isMajor = i % 3 === 0
      ctx.beginPath()
      ctx.moveTo(cx + (r - (isMajor ? 10 : 5)) * Math.cos(angle), cy + (r - (isMajor ? 10 : 5)) * Math.sin(angle))
      ctx.lineTo(cx + (r-2) * Math.cos(angle), cy + (r-2) * Math.sin(angle))
      ctx.strokeStyle = C.mark
      ctx.lineWidth = isMajor ? 1.5 : 0.5
      ctx.stroke()

      if (i % 9 === 0) {
        ctx.fillStyle = i === 0 ? C.mark : C.num   // (23/09) le N n'est plus rouge (proscrit)
        ctx.font = `bold ${size < 100 ? 8 : 9}px monospace`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const tr = r - 18
        ctx.fillText(cardinals[i/9], cx + tr * Math.cos(angle), cy + tr * Math.sin(angle))
      }
    }

    // Track bug (green)
    const trkAngle = ((trk - hdg) * Math.PI) / 180 - Math.PI/2
    ctx.strokeStyle = T.ok   // repère de route suivie : le vert reste réservé aux ÉTATS, c'en est un
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx + (r-8) * Math.cos(trkAngle), cy + (r-8) * Math.sin(trkAngle))
    ctx.lineTo(cx + (r-3) * Math.cos(trkAngle), cy + (r-3) * Math.sin(trkAngle))
    ctx.stroke()

    ctx.restore()

    // Fixed lubber line
    ctx.strokeStyle = C.own
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(cx, cy - r + 2)
    ctx.lineTo(cx, cy - r + 12)
    ctx.stroke()

    // Digital
    ctx.fillStyle = C.text
    ctx.font = `bold ${size < 100 ? 10 : 11}px monospace`
    ctx.textAlign = 'center'
    ctx.fillText(`${Math.round(hdg).toString().padStart(3,'0')}°`, cx, cy + 22)
  }, [hdg, trk, size])

  return <canvas ref={canvasRef} width={size} height={size} style={{ borderRadius: '50%' }} />
}

// ─── Turn Coordinator ─────────────────────────────────────────────────────────
function TurnCoordinator({ roll = 0, latAc = 0, size = 110 }) {
  const canvasRef = useRef(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    const cx = size/2, cy = size/2, r = size/2 - 4

    ctx.clearRect(0, 0, size, size)
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI*2)
    ctx.clip()

    // Bank marks
    const bankMarks = [-30, -20, -10, 0, 10, 20, 30]
    bankMarks.forEach(b => {
      const angle = (b - 90) * Math.PI/180
      const isMajor = b % 30 === 0
      ctx.beginPath()
      ctx.moveTo(cx + (r - (isMajor ? 10 : 6)) * Math.cos(angle), cy + (r - (isMajor ? 10 : 6)) * Math.sin(angle))
      ctx.lineTo(cx + (r-2) * Math.cos(angle), cy + (r-2) * Math.sin(angle))
      ctx.strokeStyle = C.mark
      ctx.lineWidth = isMajor ? 1.5 : 1
      ctx.stroke()
    })

    // Miniature aircraft rotated by roll
    ctx.translate(cx, cy)
    ctx.rotate((roll * Math.PI) / 180)
    ctx.strokeStyle = C.own
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(-18, 4); ctx.lineTo(-6, 4)
    ctx.moveTo(-6, 4); ctx.lineTo(0, 0)
    ctx.moveTo(0, 0); ctx.lineTo(6, 4)
    ctx.moveTo(6, 4); ctx.lineTo(18, 4)
    ctx.moveTo(-4, 14); ctx.lineTo(4, 14)
    ctx.stroke()
    ctx.restore()

    // Ball (slip indicator) — displaced by lateral acceleration
    const ballOffset = Math.max(-20, Math.min(20, latAc * 30))
    ctx.beginPath()
    ctx.arc(cx + ballOffset, cy + r - 12, 5, 0, Math.PI*2)
    ctx.fillStyle = C.mark
    ctx.fill()
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 1
    ctx.stroke()

  }, [roll, latAc, size])

  return <canvas ref={canvasRef} width={size} height={size} style={{ borderRadius: '50%' }} />
}

// ─── Main SixPack component ───────────────────────────────────────────────────
export default function SixPack({ frame, size = 110 }) {
  // (23/09) INTÉGRATION — le six-pack peignait sa PROPRE boîte sombre, arrondie et bordée de
  // blanc, posée au milieu d'une colonne blanche : un îlot flottant. Il rend maintenant une
  // simple grille 2 × 3 qui remplit la colonne (c'est la colonne, côté page, qui porte le fond
  // encre et le filet de séparation) — même traitement que les panneaux de la carte.
  const grid = {
    display: 'grid', gridTemplateColumns: '1fr 1fr',
    gap: 14, justifyItems: 'center', width: '100%',
  }
  if (!frame) return (
    <div style={grid}>
      {['ADI','AIRSPEED','ALTITUDE','VSI','HEADING','TURN'].map(l => (
        <Instrument key={l} label={l} size={size}>
          <span style={{ fontFamily: C.mono, fontSize: 11, color: C.num }}>−−</span>
        </Instrument>
      ))}
    </div>
  )

  return (
    <div style={grid}>
      <Instrument label="ADI" size={size}>
        <ADI pitch={frame.pitch} roll={frame.roll} size={size} />
      </Instrument>
      <Instrument label="AIRSPEED" size={size}>
        <AirspeedIndicator ias={frame.spd} size={size} />
      </Instrument>
      <Instrument label="ALTITUDE" size={size}>
        <Altimeter alt={frame.alt} size={size} />
      </Instrument>
      <Instrument label="VSI" size={size}>
        <VSI vspd={frame.vspd} size={size} />
      </Instrument>
      <Instrument label="HEADING" size={size}>
        <HeadingIndicator hdg={frame.hdg} trk={frame.trk} size={size} />
      </Instrument>
      <Instrument label="TURN" size={size}>
        <TurnCoordinator roll={frame.roll} latAc={frame.latAc} size={size} />
      </Instrument>
    </div>
  )
}
