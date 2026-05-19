import { useLocation, useNavigate } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { auth } from '../../firebase/config'
import { useClub } from '../../contexts/ClubContext'

// ─── Constantes ──────────────────────────────────────────────────────────────
const AMBER   = '#F5A623'
const AMBER10 = 'rgba(245,166,35,0.10)'
const AMBER20 = 'rgba(245,166,35,0.20)'
const BLUE    = '#60a5fa'
const BLUE10  = 'rgba(96,165,250,0.10)'

const ROLE_LABELS = {
  super_admin: 'SUPER',
  admin:       'ADMIN',
  instructor:  'INSTRUCTEUR',
  user:        'MEMBRE',
}
const ROLE_COLORS = {
  super_admin: '#F5A623',
  admin:       '#ef4444',
  instructor:  '#F5A623',
  user:        '#60a5fa',
}

// Tabs visibles selon rôle
function getTabs(role) {
  const tabs = [
    { path: '/live',   label: 'LIVE',    icon: '◉' },
    { path: '/replay', label: 'REPLAY',  icon: '▶' },
  ]
  if (role === 'instructor' || role === 'admin' || role === 'super_admin') {
    tabs.splice(1, 0, { path: '/en-vol',  label: 'IN FLIGHT', icon: '✈' })
    tabs.push(        { path: '/logbook', label: 'LOGBOOK',   icon: '📋' })
  }
  if (role === 'admin' || role === 'super_admin') {
    tabs.push({ path: '/admin', label: 'ADMIN', icon: '⚙' })
  }
  return tabs
}

// ─── Composant ────────────────────────────────────────────────────────────────
export default function Header({ user, role }) {
  const location = useLocation()
  const navigate  = useNavigate()
  const tabs      = getTabs(role)
  const { club, isSuperAdmin, setClub } = useClub()

  const handleSignOut = async () => {
    try { await signOut(auth) } catch (err) { console.error('[Header] signOut:', err) }
  }

  const handleSwitchClub = () => {
    setClub('')
    navigate('/select-club')
  }

  return (
    <header style={{
      height: 44,
      background: 'rgba(5,8,20,0.97)',
      borderBottom: '1px solid rgba(255,255,255,0.07)',
      display: 'flex', alignItems: 'center',
      padding: '0 12px',
      gap: 0,
      flexShrink: 0,
      zIndex: 100,
      backdropFilter: 'blur(12px)',
    }}>

      {/* Logo wordmark — remplace l'icône maison + texte par le logo brand */}
      <div style={{
        display: 'flex', alignItems: 'center',
        marginRight: 20, flexShrink: 0,
      }}>
        <img
          src="/AerotrAce_AeroTrace.png"
          alt="Aerotrace"
          style={{
            height: 22,
            // wordmark = A bleu + texte noir → on inverse en blanc pour fond sombre
            filter: 'brightness(0) invert(1)',
            opacity: 0.92,
          }}
        />
      </div>

      {/* Séparateur */}
      <div style={{ width: 1, height: 20, background: '#ffffff', marginRight: 12 }} />

      {/* Navigation tabs */}
      <nav style={{ display: 'flex', gap: 2, flex: 1 }}>
        {tabs.map(tab => {
          const active = location.pathname === tab.path ||
                         location.pathname.startsWith(tab.path + '/')
          return (
            <button
              key={tab.path}
              onClick={() => navigate(tab.path)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '0 12px', height: 28, borderRadius: 6,
                border: active ? `1px solid ${AMBER20}` : '1px solid transparent',
                background: active ? AMBER10 : 'transparent',
                cursor: 'pointer',
                transition: 'all 0.15s',
                outline: 'none',
              }}
            >
              <span style={{
                fontSize: 9,
                color: active ? AMBER : '#ffffff',
              }}>
                {tab.icon}
              </span>
              <span style={{
                fontFamily: 'monospace', fontWeight: 700,
                fontSize: 10, letterSpacing: '0.12em',
                color: active ? AMBER : '#ffffff',
                transition: 'color 0.15s',
              }}>
                {tab.label}
              </span>
              {/* Dot indicateur actif */}
              {active && (
                <span style={{
                  width: 4, height: 4, borderRadius: '50%',
                  background: AMBER, flexShrink: 0,
                  boxShadow: `0 0 6px ${AMBER}`,
                }} />
              )}
            </button>
          )
        })}
      </nav>

      {/* Droite : club + rôle + user + logout */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>

        {/* Badge club courant (toujours visible quand on est in-context) */}
        {club && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '3px 8px', borderRadius: 5,
            background: isSuperAdmin ? AMBER10 : BLUE10,
            border: `1px solid ${isSuperAdmin ? AMBER20 : 'rgba(96,165,250,0.3)'}`,
            fontFamily: 'monospace', fontSize: 10,
          }}>
            <span style={{
              fontWeight: 700, fontSize: 8, letterSpacing: '0.12em',
              color: isSuperAdmin ? AMBER : BLUE, opacity: 0.7,
            }}>
              CLUB
            </span>
            <span style={{
              fontWeight: 700, letterSpacing: '0.08em',
              color: isSuperAdmin ? AMBER : BLUE,
            }}>
              {club.code}
            </span>
            {isSuperAdmin && (
              <button onClick={handleSwitchClub} title="Switch club"
                style={{
                  background: 'transparent',
                  border: '1px solid rgba(255,255,255,0.15)',
                  color: 'rgba(255,255,255,0.6)', cursor: 'pointer',
                  padding: '1px 6px', marginLeft: 4, borderRadius: 4,
                  fontFamily: 'monospace', fontSize: 9, fontWeight: 700,
                  letterSpacing: '0.1em',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.color = '#fff'
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.4)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.color = 'rgba(255,255,255,0.6)'
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.15)'
                }}
              >
                SWITCH
              </button>
            )}
          </div>
        )}

        {/* Badge rôle */}
        {role && (
          <span style={{
            fontFamily: 'monospace', fontSize: 9, fontWeight: 700,
            letterSpacing: '0.1em',
            color: ROLE_COLORS[role] ?? '#ffffff',
            padding: '2px 7px', borderRadius: 4,
            border: `1px solid ${ROLE_COLORS[role] ?? '#ffffff'}`,
            background: `${ROLE_COLORS[role]}11` ?? 'transparent',
          }}>
            {ROLE_LABELS[role] ?? role.toUpperCase()}
          </span>
        )}

        {/* Avatar + nom */}
        {user && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            {user.photoURL ? (
              <img
                src={user.photoURL} alt=""
                style={{ width: 24, height: 24, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.1)' }}
                onError={e => {
                  e.currentTarget.style.display = 'none'
                  e.currentTarget.nextSibling.style.display = 'flex'
                }}
              />
            ) : null}
            <div style={{
              width: 24, height: 24, borderRadius: '50%',
              background: AMBER10, border: `1px solid ${AMBER20}`,
              display: user.photoURL ? 'none' : 'flex',
              alignItems: 'center', justifyContent: 'center',
              fontFamily: 'monospace', fontSize: 10, color: AMBER,
            }}>
              {(user.displayName || user.email || '?')[0].toUpperCase()}
            </div>
            <span style={{
              fontFamily: 'monospace', fontSize: 10,
              color: '#ffffff',
              maxWidth: 140, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {user.displayName || user.email}
            </span>
          </div>
        )}

        {/* Séparateur */}
        <div style={{ width: 1, height: 20, background: '#ffffff' }} />

        {/* Bouton logout */}
        <button
          onClick={handleSignOut}
          title="Déconnexion"
          style={{
            background: 'transparent', border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 6, padding: '4px 8px',
            cursor: 'pointer', transition: 'all 0.15s',
            display: 'flex', alignItems: 'center', gap: 5,
          }}
          onMouseEnter={e => {
            e.currentTarget.style.borderColor = 'rgba(255,77,77,0.4)'
            e.currentTarget.style.background  = 'rgba(255,77,77,0.06)'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.borderColor = '#ffffff'
            e.currentTarget.style.background  = 'transparent'
          }}
        >
          <span style={{ fontSize: 10, color: '#ffffff' }}>⏻</span>
          <span style={{ fontFamily: 'monospace', fontSize: 9, color: '#ffffff', letterSpacing: '0.08em' }}>
            QUIT
          </span>
        </button>
      </div>
    </header>
  )
}
