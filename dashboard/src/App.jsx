import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { onAuthStateChanged } from 'firebase/auth'
import { doc, getDoc } from 'firebase/firestore'
import { auth, db } from './firebase/config'
import LoginPage from './components/auth/LoginPage'
import Header from './components/layout/Header'
import LivePage from './pages/LivePage'
import EnVolPage from './pages/EnVolPage'
import ReplayPage from './pages/ReplayPage'
import AdminPage from './pages/AdminPage'
import LogbookPage from './pages/LogbookPage'
import DiagPage from './pages/DiagPage'

// ─── Loading screen ───────────────────────────────────────────────────────────
function LoadingScreen() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: '#050814',
      fontFamily: 'monospace', gap: 16,
    }}>
      <div style={{
        width: 32, height: 32, border: '2px solid rgba(245,166,35,0.2)',
        borderTop: '2px solid #F5A623', borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }} />
      <span style={{ fontSize: 11, letterSpacing: '0.2em', color: 'rgba(255,255,255,0.3)' }}>
        AEROTRACE
      </span>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

// ─── Role guard ───────────────────────────────────────────────────────────────
function RequireRole({ user, role, allowed, children }) {
  if (!user) return <Navigate to="/login" replace />
  if (allowed && !allowed.includes(role)) return <Navigate to="/live" replace />
  return children
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser]       = useState(null)
  const [role, setRole]       = useState(null)   // 'user' | 'instructor' | 'admin'
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser)
      if (currentUser) {
        try {
          const snap = await getDoc(doc(db, 'users', currentUser.uid))
          if (snap.exists()) {
            setRole(snap.data().role ?? 'user')
          } else {
            // First login — create user doc with default role
            const { setDoc, serverTimestamp } = await import('firebase/firestore')
            await setDoc(doc(db, 'users', currentUser.uid), {
              displayName: currentUser.displayName,
              email:       currentUser.email,
              role:        'user',
              createdAt:   serverTimestamp(),
            })
            setRole('user')
          }
        } catch (err) {
          console.error('[App] Failed to fetch user role:', err)
          setRole('user')
        }
      } else {
        setRole(null)
      }
      setLoading(false)
    })
    return () => unsubscribe()
  }, [])

  if (loading)  return <LoadingScreen />
  if (!user)    return <LoginPage />

  return (
    <BrowserRouter>
      <div style={{
        width: '100vw', height: '100vh',
        display: 'flex', flexDirection: 'column',
        overflow: 'hidden', background: '#050814',
      }}>
        <Header user={user} role={role} />

        <main style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          <Routes>
            <Route path="/"         element={<Navigate to="/live" replace />} />
            <Route path="/live"     element={<LivePage />} />

            {/* EN VOL — instructeur + admin uniquement */}
            <Route path="/en-vol"   element={
              <RequireRole user={user} role={role} allowed={['instructor', 'admin']}>
                <EnVolPage role={role} />
              </RequireRole>
            } />

            {/* REPLAY — tous les rôles */}
            <Route path="/replay"   element={<ReplayPage user={user} role={role} />} />
            <Route path="/replay/:flightId" element={<ReplayPage user={user} role={role} />} />

            <Route path="/admin" element={<RequireRole user={user} role={role} allowed={['admin']}><AdminPage role={role} /></RequireRole>} />

            {/* LOGBOOK — instructeur + admin */}
            <Route path="/logbook" element={
              <RequireRole user={user} role={role} allowed={['instructor', 'admin']}>
                <LogbookPage />
              </RequireRole>
            } />

            {/* DIAG — temporaire, admin only */}
            <Route path="/diag" element={
              <RequireRole user={user} role={role} allowed={['admin']}>
                <DiagPage />
              </RequireRole>
            } />

            <Route path="*"         element={<Navigate to="/live" replace />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  )
}
