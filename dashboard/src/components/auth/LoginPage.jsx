import { signInWithPopup } from 'firebase/auth'
import { auth, provider } from '../../firebase/config'

export default function LoginPage() {
  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, provider)
    } catch (error) {
      console.error('Login error:', error)
    }
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      background: '#0a0f1e',
      color: 'white',
      fontFamily: 'monospace'
    }}>
      <h1 style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>
        ✈️ AeroTrace
      </h1>
      <p style={{ color: '#888', marginBottom: '2rem' }}>
        Instructor Dashboard
      </p>
      <button
        onClick={handleLogin}
        style={{
          padding: '12px 32px',
          fontSize: '1rem',
          background: '#1a73e8',
          color: 'white',
          border: 'none',
          borderRadius: '8px',
          cursor: 'pointer'
        }}
      >
        Se connecter avec Google
      </button>
    </div>
  )
}