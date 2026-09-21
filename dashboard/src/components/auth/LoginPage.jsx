import { useState } from 'react'
import { signInWithPopup, signInWithRedirect } from 'firebase/auth'
import { auth, provider } from '../../firebase/config'
import { AirKiLockup } from '../ui/AirKiMark'

export default function LoginPage() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const handleLogin = async () => {
    setError(''); setBusy(true)
    // Popup EN PRIORITÉ : fiable sur desktop et immunisé au blocage des cookies
    // tiers (le redirect casse quand le site — .web.app — diffère de l'authDomain
    // — .firebaseapp.com — : Safari partitionne le storage, la session est perdue
    // au retour). Repli redirect uniquement si le popup est bloqué (mobile).
    try {
      await signInWithPopup(auth, provider)
      // succès → onAuthStateChanged (App.jsx) prend le relais
    } catch (e) {
      if (e.code === 'auth/popup-blocked' || e.code === 'auth/cancelled-popup-request'
          || e.code === 'auth/operation-not-supported-in-this-environment') {
        try { await signInWithRedirect(auth, provider); return }
        catch (e2) { setError(e2.message) }
      } else if (e.code === 'auth/popup-closed-by-user') {
        // annulé par l'utilisateur → pas d'erreur affichée
      } else {
        console.error('Login error:', e)
        setError(e.message || 'Sign-in failed')
      }
      setBusy(false)
    }
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: 'var(--ink)',   // (21/09) encre AirKi — plus de bleu nuit (règle « pas de navy »)
      color: '#FFFFFF', fontFamily: 'var(--font-sans)',
    }}>
      {/* (21/09) bloc unique : le bouton prend EXACTEMENT la largeur du lockup (même axe gauche/droite), groupe
          remonté de 6 vh pour un centrage optique (un bloc parfaitement centré paraît trop bas). */}
      <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'stretch', gap: 44, marginBottom: '6vh' }}>
        <AirKiLockup size={64} color="#FFFFFF" baseline />
        <button
          onClick={handleLogin}
          disabled={busy}
          style={{
            height: 48, padding: '0 22px', fontSize: 15, fontWeight: 500, fontFamily: 'var(--font-sans)',
            background: '#FFFFFF', color: 'var(--ink)', opacity: busy ? 0.7 : 1,   // primaire sur encre = blanc / texte encre
            border: 'none', borderRadius: 4, cursor: busy ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Signing in…' : 'Continue with Google'}
        </button>
      </div>
      {error && (
        <div style={{ color: '#FFFFFF', fontSize: 12, marginTop: 18, maxWidth: 360, textAlign: 'center', lineHeight: 1.5 }}>
          {error}
        </div>
      )}
    </div>
  )
}
