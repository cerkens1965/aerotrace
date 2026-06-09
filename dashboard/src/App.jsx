import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { onAuthStateChanged, getRedirectResult } from 'firebase/auth'
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
import SelectClubPage from './pages/SelectClubPage'
import { ClubProvider, useClub } from './contexts/ClubContext'

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
  const [user, setUser]             = useState(null)
  const [role, setRole]             = useState(null)   // 'user' | 'instructor' | 'admin' | 'super_admin'
  const [userClubId, setUserClubId] = useState('')      // clubId imposé pour admin/user (vide pour super_admin)
  const [loading, setLoading]       = useState(true)

  useEffect(() => {
    // Login par redirect (mobile/tablette) : remonte une éventuelle erreur au retour.
    // La session elle-même est récupérée par onAuthStateChanged ci-dessous.
    getRedirectResult(auth).catch((e) => console.error('Redirect login error:', e))
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser)
      if (currentUser) {
        try {
          const snap = await getDoc(doc(db, 'users', currentUser.uid))
          if (snap.exists()) {
            setRole(snap.data().role ?? 'user')
            setUserClubId(snap.data().clubId ?? '')
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
            setUserClubId('')
          }
        } catch (err) {
          console.error('[App] Failed to fetch user role:', err)
          setRole('user')
          setUserClubId('')
        }
      } else {
        setRole(null)
        setUserClubId('')
      }
      setLoading(false)
    })
    return () => unsubscribe()
  }, [])

  if (loading)  return <LoadingScreen />
  if (!user)    return <LoginPage />

  return (
    <BrowserRouter>
      <ClubProvider role={role} userClubId={userClubId}>
        <AppLayout user={user} role={role} userClubId={userClubId} />
      </ClubProvider>
    </BrowserRouter>
  )
}

// ─── AppLayout ────────────────────────────────────────────────────────────────
// Sépare le routing pour pouvoir consommer useClub() au-dessus des Routes.
// super_admin sans clubId courant → forcé sur /select-club.
// admin sans clubId imposé → message d'erreur (compte non rattaché à un club).
function AppLayout({ user, role, userClubId }) {
  const { clubId, isSuperAdmin } = useClub()

  // super_admin sans choix → picker obligatoire
  if (isSuperAdmin && !clubId) {
    return (
      <Routes>
        <Route path="/select-club" element={<SelectClubPage />} />
        <Route path="*"            element={<Navigate to="/select-club" replace />} />
      </Routes>
    )
  }

  // admin/instructor avec rôle élevé mais sans clubId rattaché → bloqué
  if (!isSuperAdmin && (role === 'admin' || role === 'instructor') && !userClubId) {
    return <NoClubAssignedScreen role={role} />
  }

  return (
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

          {/* /select-club accessible aussi en pleine session pour switch club (super_admin) */}
          <Route path="/select-club" element={<SelectClubPage />} />

          {/* EN VOL — instructeur + admin (+ super_admin) */}
          <Route path="/en-vol"   element={
            <RequireRole user={user} role={role} allowed={['instructor', 'admin', 'super_admin']}>
              <EnVolPage role={role} />
            </RequireRole>
          } />

          {/* REPLAY — tous les rôles */}
          <Route path="/replay"   element={<ReplayPage user={user} role={role} />} />
          <Route path="/replay/:flightId" element={<ReplayPage user={user} role={role} />} />

          <Route path="/admin" element={
            <RequireRole user={user} role={role} allowed={['admin', 'super_admin']}>
              <AdminPage role={role} />
            </RequireRole>
          } />

          {/* LOGBOOK — instructeur + admin (+ super_admin) */}
          <Route path="/logbook" element={
            <RequireRole user={user} role={role} allowed={['instructor', 'admin', 'super_admin']}>
              <LogbookPage />
            </RequireRole>
          } />

          {/* DIAG — temporaire, admin only (+ super_admin) */}
          <Route path="/diag" element={
            <RequireRole user={user} role={role} allowed={['admin', 'super_admin']}>
              <DiagPage />
            </RequireRole>
          } />

          <Route path="*" element={<Navigate to="/live" replace />} />
        </Routes>
      </main>
    </div>
  )
}

// ─── NoClubAssignedScreen ─────────────────────────────────────────────────────
// Affiché si un admin/instructor n'a pas de clubId rattaché dans son user doc.
function NoClubAssignedScreen({ role }) {
  const handleSignOut = async () => {
    const { signOut } = await import('firebase/auth')
    try { await signOut(auth) } catch (err) { console.error('[NoClub] signOut:', err) }
  }
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      height: '100vh', background: '#050814',
      fontFamily: 'monospace', color: '#fff',
      padding: 40, textAlign: 'center',
    }}>
      <div style={{
        fontSize: 9, letterSpacing: '0.3em',
        color: 'rgba(245,166,35,0.7)', marginBottom: 16,
      }}>
        AEROTRACE
      </div>
      <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>
        No club assigned to your account
      </h1>
      <div style={{
        fontSize: 12, color: 'rgba(255,255,255,0.6)',
        marginTop: 12, maxWidth: 420, lineHeight: 1.6,
      }}>
        Your role is <strong>{role}</strong> but no <code>clubId</code> is set on
        your user document. Ask your platform super_admin to assign you a club, or
        change your role to <code>super_admin</code> to manage multiple clubs.
      </div>
      <button onClick={handleSignOut}
        style={{
          marginTop: 32, padding: '10px 22px', borderRadius: 6,
          background: 'transparent', border: '1px solid rgba(255,255,255,0.2)',
          color: 'rgba(255,255,255,0.8)', cursor: 'pointer',
          fontFamily: 'monospace', fontSize: 11, letterSpacing: '0.1em',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.borderColor = '#ef4444'; e.currentTarget.style.color = '#ef4444' }}
        onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'; e.currentTarget.style.color = 'rgba(255,255,255,0.8)' }}
      >
        SIGN OUT
      </button>
    </div>
  )
}
