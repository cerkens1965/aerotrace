import { useState, useEffect } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { auth } from './firebase/config'
import LoginPage from './components/auth/LoginPage'

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser)
      setLoading(false)
    })
    return () => unsubscribe()
  }, [])

  if (loading) return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      background: '#0a0f1e',
      color: 'white',
      fontFamily: 'monospace'
    }}>
      Chargement...
    </div>
  )

  if (!user) return <LoginPage />

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100vh',
      background: '#0a0f1e',
      color: 'white',
      fontFamily: 'monospace'
    }}>
      <div style={{ textAlign: 'center' }}>
        <h1>✈️ AeroTrace</h1>
        <p>Bienvenue {user.displayName} !</p>
        <p style={{ color: '#888' }}>Dashboard en construction...</p>
      </div>
    </div>
  )
}

export default App