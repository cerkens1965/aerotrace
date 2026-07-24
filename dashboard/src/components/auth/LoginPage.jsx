import { useState } from 'react'
import { signInWithPopup, signInWithRedirect } from 'firebase/auth'
import { auth, provider } from '../../firebase/config'

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
      height: '100vh', background: '#0a0f1e',
      color: 'white', fontFamily: 'monospace',
    }}>
      <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>✈️ AeroTrace</h1>
      <p style={{ color: '#888', marginBottom: '2rem' }}>Instructor Dashboard</p>
      <button
        onClick={handleLogin}
        disabled={busy}
        style={{
          padding: '12px 32px', fontSize: '1rem',
          background: busy ? '#3b5da8' : '#1a73e8', color: 'white',
          border: 'none', borderRadius: '8px', cursor: busy ? 'default' : 'pointer',
        }}
      >
        {busy ? 'Connexion…' : 'Se connecter avec Google'}
      </button>
      {error && (
        <div style={{ color: '#ef4444', fontSize: 12, marginTop: 18, maxWidth: 360, textAlign: 'center', lineHeight: 1.5 }}>
          {error}
        </div>
      )}
    </div>
  )
}
