import { useLocation, useNavigate } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { auth } from '../../firebase/config'

// ─── Constantes ──────────────────────────────────────────────────────────────
const AMBER   = '#F5A623'
const AMBER10 = 'rgba(245,166,35,0.10)'
const AMBER20 = 'rgba(245,166,35,0.20)'

const ROLE_LABELS = {
  admin:      'ADMIN',
  instructor: 'INSTRUCTEUR',
  student:    'ÉLÈVE',
}
const ROLE_COLORS = {
  admin:      '#ff4d4d',
  instructor: AMBER,
  student:    '#ffffff',
}

// Tabs visibles selon rôle
function getTabs(role) {
  const tabs = [
    { path: '/live',   label: 'LIVE',    icon: '◉' },
    { path: '/replay', label: 'REPLAY',  icon: '▶' },
  ]
  if (role === 'instructor' || role === 'admin') {
    tabs.splice(1, 0, { path: '/en-vol', label: 'IN FLIGHT', icon: '✈' })
  }
  if (role === 'admin') {
    tabs.push({ path: '/admin', label: 'ADMIN', icon: '⚙' })
  }
  return tabs
}

// ─── Composant ────────────────────────────────────────────────────────────────
export default function Header({ user, role }) {
  const location = useLocation()
  const navigate  = useNavigate()
  const tabs      = getTabs(role)

  const handleSignOut = async () => {
    try { await signOut(auth) } catch (err) { console.error('[Header] signOut:', err) }
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

      {/* Logo */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginRight: 20, flexShrink: 0,
      }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M12 2L3 9v13h18V9L12 2z" stroke={AMBER} strokeWidth="1.5" fill="none"/>
          <path d="M9 22V12h6v10" stroke={AMBER} strokeWidth="1.5" strokeOpacity="0.5"/>
          <circle cx="12" cy="7" r="1.5" fill={AMBER}/>
        </svg>
        <span style={{
          fontFamily: 'monospace', fontWeight: 700,
          fontSize: 12, letterSpacing: '0.2em',
          color: 'rgba(255,255,255,0.9)',
        }}>
          AEROTRACE
        </span>
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

      {/* Droite : rôle + user + logout */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>

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
              />
            ) : (
              <div style={{
                width: 24, height: 24, borderRadius: '50%',
                background: AMBER10, border: `1px solid ${AMBER20}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontFamily: 'monospace', fontSize: 10, color: AMBER,
              }}>
                {(user.displayName || user.email || '?')[0].toUpperCase()}
              </div>
            )}
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
