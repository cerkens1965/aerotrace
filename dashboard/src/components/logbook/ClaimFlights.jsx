// ClaimFlights — « ce vol est-il le tien ? » (24/09/2026, copropriété).
//
// Un avion détenu à plusieurs ne permet pas de déduire qui était aux commandes : le vol
// n'est attribué à personne et s'ouvre en REVENDICATION chez chaque copropriétaire. C'est
// le seul endroit du carnet où un pilote écrit lui-même sur un vol — et il n'écrit pas
// vraiment : il appelle `claimFlight`, qui vérifie côté serveur qu'il est bien candidat
// (les règles Firestore réservent l'écriture des vols aux instructeurs et aux admins).
//
// Premier arrivé, premier servi. Si quelqu'un a déjà répondu, on ne lui prend pas le vol :
// le conflit est tracé et l'admin tranche. D'où le message explicite plutôt qu'un échec muet.
import { useState } from 'react'
import { Button, T, labelStyle, monoStyle, Banner } from '../ui'
import { formatDate, formatDuration } from '../../utils/logbookUtils'
import { claimFlight } from '../../utils/claim'

const utcTime = (ts) => {
  const t = ts?.toMillis?.() ?? Number(ts)
  if (!t) return '−−:−−'
  const d = new Date(t)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`
}

export default function ClaimFlights({ flights = [], acLabel, othersOf }) {
  const [busy, setBusy] = useState(null)      // id du vol en cours d'envoi
  const [msg, setMsg]   = useState(null)      // { tone, title, text }

  if (!flights.length && !msg) return null

  const answer = async (f, mine) => {
    setBusy(f.id); setMsg(null)
    try {
      const data = await claimFlight(f.id, mine)
      if (data?.state === 'claimed') {
        setMsg({ tone: 'ok', title: 'Flight added to your logbook.', text: 'It now counts in your hours.' })
      } else if (data?.state === 'conflict') {
        // Quelqu'un a répondu avant. On ne lui retire pas le vol : l'admin tranchera.
        setMsg({ tone: 'caution', title: 'Someone else has already claimed this flight.',
                 text: 'Your claim has been recorded — a club admin will settle it.' })
      } else if (data?.state === 'unclaimed') {
        setMsg({ tone: 'info', title: 'Noted — nobody claimed this flight.',
                 text: 'It goes back to the assignment queue for an instructor or admin.' })
      } else {
        setMsg({ tone: 'info', title: 'Noted.', text: 'The other owners can still claim this flight.' })
      }
    } catch (e) {
      setMsg({ tone: 'caution', title: 'The flight could not be updated.', text: e?.message || String(e) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-label="Flights to confirm" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h2 style={{ fontFamily: T.sans, fontSize: 15, fontWeight: 600, letterSpacing: '-0.02em', color: T.ink, margin: 0 }}>
          To confirm
        </h2>
        <span style={labelStyle(T.etch)}>{flights.length} FLIGHT{flights.length === 1 ? '' : 'S'} ON A SHARED AIRCRAFT</span>
      </div>

      {msg && <Banner tone={msg.tone} title={msg.title}>{msg.text}</Banner>}

      {flights.map((f) => {
        const others = othersOf?.(f) || []
        return (
          <div key={f.id} style={{
            background: T.card, border: T.border, borderRadius: T.radius.md, padding: '14px 16px',
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14,
          }}>
            <div style={{ minWidth: 0, flex: '1 1 240px' }}>
              <div style={{ ...monoStyle(14, T.ink), fontWeight: 500 }}>
                {acLabel ? acLabel(f.aircraftIdent) : f.aircraftIdent}
                <span style={{ color: T.etch }}> · </span>
                {formatDate(f.startTs)}
                <span style={{ color: T.etch }}> · </span>
                {utcTime(f.startTs)}
              </div>
              <div style={{ fontFamily: T.sans, fontSize: 12, color: T.graphite, marginTop: 4 }}>
                {formatDuration(f.duration)}
                {f.depIcao || f.arrIcao ? ` · ${f.depIcao || '−−−−'} → ${f.arrIcao || '−−−−'}` : ''}
                {others.length ? ` · shared with ${others.join(', ')}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button size="sm" variant="primary" disabled={busy === f.id} onClick={() => answer(f, true)}>
                Yes, I flew it
              </Button>
              <Button size="sm" variant="secondary" disabled={busy === f.id} onClick={() => answer(f, false)}>
                Not me
              </Button>
            </div>
          </div>
        )
      })}
    </section>
  )
}
