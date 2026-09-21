// RedeemInvite — saisie du CODE D'INVITATION pilote (2026-09-21).
// Le club génère un code à usage unique pour une fiche pilote (Admin → Pilots → Invite code).
// Le pilote, connecté avec n'importe quel compte (Google, Apple…), saisit ici le code :
// la fonction cloud redeemInvite rattache le compte au club et le relie à sa fiche pilote.
// onDone() est appelé après succès (le parent recharge l'accès / la page).
// dark = true sur fond encre (écran Access pending), false sur fond papier (Logbook).
import { useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../../firebase/config'
import { Button, T, labelStyle } from '../ui'

const fmt = (v) => {
  const c = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

export default function RedeemInvite({ onDone, dark = false }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg]   = useState(null)   // { ok:boolean, text }
  const fg    = dark ? T.white : T.ink
  const muted = dark ? T.mutedDark : T.graphite
  const line  = dark ? T.ruleDark : T.rule
  const ready = code.replace('-', '').length === 8

  const submit = async (e) => {
    e?.preventDefault()
    if (!ready || busy) return
    setBusy(true); setMsg(null)
    try {
      const { data } = await httpsCallable(functions, 'redeemInvite')({ code })
      setMsg({ ok: true, text: `Linked to pilot ${data?.trigram || ''}. Loading your flights…`.replace('  ', ' ') })
      setTimeout(() => onDone?.(data), 900)
    } catch (err) {
      setMsg({ ok: false, text: err?.message?.replace(/^.*?: /, '') || 'The code could not be used. Try again.' })
    } finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'stretch', width: '100%', maxWidth: 360 }}>
      <label htmlFor="invite-code" style={{ ...labelStyle(muted), textAlign: 'left' }}>
        INVITATION CODE
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input id="invite-code" value={code} onChange={(e) => setCode(fmt(e.target.value))}
          placeholder="ABCD-2345" autoComplete="off" spellCheck={false} inputMode="text"
          className="ak-focus"
          style={{ flex: 1, minWidth: 0, padding: '10px 12px', borderRadius: T.radius.sm, border: `1px solid ${line}`,
                   background: dark ? T.ink : T.card, color: fg,
                   fontFamily: T.mono, fontSize: 18, letterSpacing: '0.12em', textTransform: 'uppercase' }} />
        <Button type="submit" variant="primary" onInk={dark} disabled={!ready || busy}
          style={{ height: 'auto', padding: '0 16px' }}>
          {busy ? 'Checking…' : 'Link my account'}
        </Button>
      </div>
      {msg && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: T.sans, fontSize: 12, color: fg, textAlign: 'left' }}>
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: T.radius.pill, flexShrink: 0, background: msg.ok ? T.ok : T.amber }} />
          {msg.text}
        </div>
      )}
    </form>
  )
}
