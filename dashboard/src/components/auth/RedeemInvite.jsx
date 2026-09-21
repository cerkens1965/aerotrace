// RedeemInvite — saisie du CODE D'INVITATION pilote (2026-09-21).
// Le club génère un code à usage unique pour une fiche pilote (Admin → Pilots → Invite code).
// Le pilote, connecté avec n'importe quel compte (Google, Apple…), saisit ici le code :
// la fonction cloud redeemInvite rattache le compte au club et le relie à sa fiche pilote.
// onDone() est appelé après succès (le parent recharge l'accès / la page).
// dark = true sur fond encre (écran Access pending), false sur fond papier (Logbook).
import { useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../../firebase/config'

const fmt = (v) => {
  const c = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return c.length > 4 ? `${c.slice(0, 4)}-${c.slice(4)}` : c
}

export default function RedeemInvite({ onDone, dark = false }) {
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg]   = useState(null)   // { ok:boolean, text }
  const fg    = dark ? '#FFFFFF' : 'var(--ink)'
  const muted = dark ? '#9A9A94' : 'var(--graphite)'
  const line  = dark ? '#2C2C2C' : 'var(--rule)'
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
      <label htmlFor="invite-code" style={{ fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', color: muted, textAlign: 'left' }}>
        INVITATION CODE
      </label>
      <div style={{ display: 'flex', gap: 8 }}>
        <input id="invite-code" value={code} onChange={(e) => setCode(fmt(e.target.value))}
          placeholder="ABCD-2345" autoComplete="off" spellCheck={false} inputMode="text"
          style={{ flex: 1, minWidth: 0, padding: '10px 12px', borderRadius: 4, border: `1px solid ${line}`,
                   background: dark ? '#141414' : '#FFFFFF', color: fg,
                   fontFamily: 'var(--font-mono)', fontSize: 18, letterSpacing: '0.12em', textTransform: 'uppercase' }} />
        <button type="submit" disabled={!ready || busy}
          style={{ padding: '10px 16px', borderRadius: 4, border: 'none', cursor: ready && !busy ? 'pointer' : 'default',
                   background: dark ? '#FFFFFF' : 'var(--ink)', color: dark ? 'var(--ink)' : '#FFFFFF',
                   opacity: ready && !busy ? 1 : 0.5, fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: 13 }}>
          {busy ? 'Checking…' : 'Link my account'}
        </button>
      </div>
      {msg && (
        <div role="status" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: fg, textAlign: 'left' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: msg.ok ? 'var(--ok)' : 'var(--amber)' }} />
          {msg.text}
        </div>
      )}
    </form>
  )
}
