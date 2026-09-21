import { useState, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom'
import { onAuthStateChanged, getRedirectResult } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import RedeemInvite from './components/auth/RedeemInvite'
import { doc, getDoc } from 'firebase/firestore'
import { auth, functions, db } from './firebase/config'
import LoginPage from './components/auth/LoginPage'
import Sidebar from './components/layout/Sidebar'
import LivePage from './pages/LivePage'
import EnVolPage from './pages/EnVolPage'
import ReplayPage from './pages/ReplayPage'
import AdminPage from './pages/AdminPage'
import LogbookPage from './pages/LogbookPage'
import DevPage from './pages/DevPage'
import FleetPage from './pages/FleetPage'
import SelectClubPage from './pages/SelectClubPage'
import { ClubProvider, useClub } from './contexts/ClubContext'
import { Button, Skeleton, T, headingStyle } from './components/ui'
import { AirKiLockup } from './components/ui/AirKiMark'

// ─── Écrans plein cadre sur encre (chargement, accès) ────────────────────────
// Règles DS : fond encre, lockup AirKi (jamais le mot en texte seul), titre Instrument Sans
// Semibold blanc, texte #9A9A94 (pas d'alpha), boutons onInk, aucun rouge.
const inkScreen = (height) => ({
  display: 'flex', flexDirection: 'column',
  alignItems: 'center', justifyContent: 'center',
  height, background: T.ink,
  fontFamily: T.sans, color: T.white,
  padding: 40, textAlign: 'center',
})
const INK_TITLE = { ...headingStyle(20, T.white), margin: '24px 0 0' }
const INK_TEXT  = { fontSize: 13, color: T.mutedDark, marginTop: 12, maxWidth: 440, lineHeight: 1.6 }
const INK_STRONG = { color: T.white, fontWeight: 600 }
const INK_CODE  = { fontFamily: T.mono, fontSize: 12, color: T.white }

// ─── Loading screen ───────────────────────────────────────────────────────────
function LoadingScreen() {
  return (
    <div role="status" aria-label="Loading" style={{ ...inkScreen('100vh'), gap: 24 }}>
      <AirKiLockup size={28} color={T.white} />
      <Skeleton width={120} height={2} radius={1} style={{ background: T.ruleDark }} />
    </div>
  )
}

// ─── Role guard ───────────────────────────────────────────────────────────────
// Rôle insuffisant → écran « Not allowed » explicite (plus de redirection silencieuse vers /live).
function RequireRole({ user, role, allowed, children }) {
  if (!user) return <Navigate to="/login" replace />
  if (allowed && !allowed.includes(role)) return <NotAllowedScreen role={role} allowed={allowed} />
  return children
}

const ROLE_NAMES = { super_admin: 'Super admin', admin: 'Admin', instructor: 'Instructor', user: 'Pilot' }
const roleName = (r) => ROLE_NAMES[r] ?? r

// ─── NotAllowedScreen ─────────────────────────────────────────────────────────
// Même présentation que AccessPendingScreen / NoClubAssignedScreen, mais rendu DANS la
// mise en page (la barre latérale reste visible) → hauteur 100 % du <main>, pas 100vh.
function NotAllowedScreen({ role, allowed }) {
  const navigate = useNavigate()
  // super_admin est implicite partout où admin est admis : on ne liste que les rôles « visibles ».
  const required = allowed.filter(r => r !== 'super_admin').map(roleName)
  const requiredTxt = required.length > 1
    ? `${required.slice(0, -1).join(', ')} or ${required[required.length - 1]}`
    : (required[0] ?? roleName(allowed[0]))
  return (
    <div style={inkScreen('100%')}>
      <AirKiLockup size={22} color={T.white} />
      <h1 style={INK_TITLE}>Not allowed</h1>
      <div style={INK_TEXT}>
        This page requires the <strong style={INK_STRONG}>{requiredTxt}</strong> role. Your role
        is <strong style={INK_STRONG}>{roleName(role)}</strong>. Ask an administrator if you need access.
      </div>
      <Button variant="primary" onInk onClick={() => navigate('/live')} style={{ marginTop: 32 }}>
        Back to Live
      </Button>
    </div>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser]             = useState(null)
  const [role, setRole]             = useState(null)   // 'user' | 'instructor' | 'admin' | 'super_admin'
  const [userClubId, setUserClubId] = useState('')      // clubId imposé pour admin/user (vide pour super_admin)
  const [authorized, setAuthorized] = useState(false)   // (allowlist) désigné par un admin ?
  const [loading, setLoading]       = useState(true)

  useEffect(() => {
    // Login par redirect (mobile/tablette) : remonte une éventuelle erreur au retour.
    // La session elle-même est récupérée par onAuthStateChanged ci-dessous.
    getRedirectResult(auth).catch((e) => console.error('Redirect login error:', e))
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser)
      if (currentUser) {
        try {
          // Contrôle d'accès « personnes désignées » : le serveur (claimAccess) décide
          // et PROVISIONNE (rôle/club) uniquement si l'email a été invité par un admin.
          // Aucun rôle n'est écrit par le client → pas d'auto-attribution possible.
          const claim = httpsCallable(functions, 'claimAccess')
          const { data } = await claim()
          setAuthorized(!!data?.authorized)
          setRole(data?.role ?? 'user')
          setUserClubId(data?.clubId ?? '')
        } catch (err) {
          // REPLI (résilience) : si la Cloud Function est indisponible (billing coupé,
          // panne, cold-start KO), on NE verrouille PAS tout le monde. On lit le doc
          // /users directement : un utilisateur DÉJÀ provisionné (super_admin ou clubId)
          // garde l'accès. Le provisioning d'un NOUVEL invité, lui, exige la fonction.
          console.warn('[App] claimAccess indispo → repli lecture /users:', err?.message || err)
          try {
            const snap = await getDoc(doc(db, 'users', currentUser.uid))
            const u = snap.exists() ? snap.data() : null
            const ok = !!u && (u.role === 'super_admin' || !!u.clubId)
            setAuthorized(ok)
            setRole(u?.role ?? 'user')
            setUserClubId(u?.clubId ?? '')
          } catch (e2) {
            console.error('[App] repli /users échoué:', e2)
            setAuthorized(false); setRole('user'); setUserClubId('')
          }
        }
      } else {
        setAuthorized(false)
        setRole(null)
        setUserClubId('')
      }
      setLoading(false)
    })
    return () => unsubscribe()
  }, [])

  if (loading)  return <LoadingScreen />
  if (!user)    return <LoginPage />
  if (!authorized) return <AccessPendingScreen user={user} />

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
      display: 'flex', flexDirection: 'row',
      overflow: 'hidden', background: 'var(--paper)',
    }}>
      <Sidebar user={user} role={role} />

      <main style={{ flex: 1, minWidth: 0, overflow: 'hidden', position: 'relative' }}>
        <Routes>
          <Route path="/"         element={<Navigate to="/live" replace />} />
          <Route path="/live"     element={<LivePage />} />

          {/* /select-club accessible aussi en pleine session pour switch club (super_admin) */}
          <Route path="/select-club" element={<SelectClubPage />} />

          {/* IN FLIGHT — instructeur + admin (+ super_admin). /en-vol = ancien chemin, redirigé. */}
          <Route path="/en-vol"   element={<Navigate to="/in-flight" replace />} />
          <Route path="/in-flight" element={
            <RequireRole user={user} role={role} allowed={['instructor', 'admin', 'super_admin']}>
              <EnVolPage role={role} />
            </RequireRole>
          } />

          {/* LOOP (lecteur d'un vol) — tous les rôles. /replay seul = état vide renvoyant au Logbook */}
          <Route path="/replay"   element={<ReplayPage role={role} />} />
          <Route path="/replay/:flightId" element={<ReplayPage role={role} />} />

          <Route path="/admin" element={
            <RequireRole user={user} role={role} allowed={['admin', 'super_admin']}>
              <AdminPage role={role} />
            </RequireRole>
          } />

          {/* LOGBOOK — tous les rôles connectés. Le pilote (user) n'y voit que « My flights » :
              la restriction est faite dans LogbookPage d'après le rôle passé en prop. */}
          <Route path="/logbook" element={
            <RequireRole user={user} role={role} allowed={['user', 'instructor', 'admin', 'super_admin']}>
              <LogbookPage role={role} />
            </RequireRole>
          } />

          {/* DEV — outils LTE + simulateur, admin + super_admin */}
          <Route path="/dev" element={
            <RequireRole user={user} role={role} allowed={['admin', 'super_admin']}>
              <DevPage />
            </RequireRole>
          } />
          {/* FLEET — état firmware des boîtiers/écrans, admin + super_admin */}
          <Route path="/fleet" element={
            <RequireRole user={user} role={role} allowed={['admin', 'super_admin']}>
              <FleetPage />
            </RequireRole>
          } />

          <Route path="*" element={<Navigate to="/live" replace />} />
        </Routes>
      </main>
    </div>
  )
}

// ─── AccessPendingScreen ──────────────────────────────────────────────────────
// Connecté avec Google mais PAS désigné (aucune invitation admin pour cet email).
// L'utilisateur ne voit aucune donnée : il doit être invité par un admin.
function AccessPendingScreen({ user }) {
  const handleSignOut = async () => {
    const { signOut } = await import('firebase/auth')
    try { await signOut(auth) } catch (err) { console.error('[Pending] signOut:', err) }
  }
  return (
    <div style={inkScreen('100vh')}>
      <AirKiLockup size={22} color={T.white} />
      <h1 style={INK_TITLE}>Access pending</h1>
      <div style={INK_TEXT}>
        You are signed in as <strong style={INK_STRONG}>{user?.email || 'this account'}</strong>, but this
        account has not been granted access yet. Enter the invitation code given by your club,
        or ask an administrator to invite your e-mail.
      </div>
      <div style={{ marginTop: 24, width: '100%', display: 'flex', justifyContent: 'center' }}>
        <RedeemInvite dark onDone={() => window.location.reload()} />
      </div>
      <Button variant="secondary" onInk onClick={handleSignOut} style={{ marginTop: 32 }}>
        Sign out
      </Button>
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
    <div style={inkScreen('100vh')}>
      <AirKiLockup size={22} color={T.white} />
      <h1 style={INK_TITLE}>No club assigned to your account</h1>
      <div style={{ ...INK_TEXT, maxWidth: 420 }}>
        Your role is <strong style={INK_STRONG}>{role}</strong> but no <code style={INK_CODE}>clubId</code> is set on
        your user document. Ask your platform super_admin to assign you a club, or
        change your role to <code style={INK_CODE}>super_admin</code> to manage multiple clubs.
      </div>
      <Button variant="secondary" onInk onClick={handleSignOut} style={{ marginTop: 32 }}>
        Sign out
      </Button>
    </div>
  )
}
