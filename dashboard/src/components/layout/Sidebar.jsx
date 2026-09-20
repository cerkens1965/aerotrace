// Sidebar — coquille AirKi (design system 2026-09) : barre latérale 180 px sur encre.
//   Haut   : lockup (monogramme deux couleurs + « AirKi »).
//   Milieu : navigation Live / In flight / Loop / Logbook / Fleet / Admin / Dev selon le rôle.
//   Bas    : club + ICAO, rôle, utilisateur, version, déconnexion.
// Règles : la marque s'écrit toujours « AirKi » (jamais en capitales) ; pas de dégradé, pas d'ombre,
// bordures 1 px ; texte sur encre = blanc ou #9A9A94 ; chiffres et libellés techniques en Geist Mono.
import { useLocation, useNavigate } from 'react-router-dom'
import { signOut } from 'firebase/auth'
import { auth } from '../../firebase/config'
import { useClub } from '../../contexts/ClubContext'
import { APP_VERSION, APP_CHANNEL, BUILD_DATE } from '../../version'
import { AirKiLockup } from '../ui/AirKiMark'

const ROLE_LABELS = { super_admin: 'Super admin', admin: 'Admin', instructor: 'Instructor', user: 'Member' }

// Navigation visible selon rôle. Les libellés sont des mots, jamais des capitales (règle de marque).
function getNav(role) {
  const nav = [
    { path: '/live',   label: 'Live' },
    { path: '/replay', label: 'Loop' },     // Loop = texte seul, Semibold — jamais coloré, jamais avec le monogramme
  ]
  if (role === 'instructor' || role === 'admin' || role === 'super_admin') {
    nav.splice(1, 0, { path: '/en-vol', label: 'In flight' })
    nav.push({ path: '/logbook', label: 'Logbook' })
  }
  if (role === 'admin' || role === 'super_admin') {
    nav.push({ path: '/fleet', label: 'Fleet' })
    nav.push({ path: '/admin', label: 'Admin' })
    nav.push({ path: '/dev',   label: 'Dev' })
  }
  return nav
}

const S = {
  aside: {
    width: 180, flexShrink: 0, height: '100%',
    background: 'var(--ink)', color: '#FFFFFF',
    borderRight: '1px solid var(--rule-dark)',
    display: 'flex', flexDirection: 'column',
    fontFamily: 'var(--font-sans)',
  },
  head: { padding: '18px 16px 14px', borderBottom: '1px solid var(--rule-dark)' },
  nav: { display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 8px', flex: 1 },
  item: (active) => ({
    display: 'flex', alignItems: 'center', height: 32, padding: '0 10px',
    borderRadius: 4, border: '1px solid transparent', cursor: 'pointer',
    background: active ? '#FFFFFF' : 'transparent',
    color: active ? 'var(--ink)' : '#FFFFFF',
    fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 13, letterSpacing: '-0.01em',
    textAlign: 'left', width: '100%',
  }),
  foot: { padding: '12px 16px 14px', borderTop: '1px solid var(--rule-dark)', display: 'flex', flexDirection: 'column', gap: 8 },
  mono: { fontFamily: 'var(--font-mono)', fontVariantNumeric: 'tabular-nums', fontSize: 11, color: 'var(--muted-dark)' },
  label: { fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--muted-dark)' },
  btn: {
    background: 'transparent', border: '1px solid var(--rule-dark)', color: '#FFFFFF',
    borderRadius: 4, padding: '5px 8px', cursor: 'pointer',
    fontFamily: 'var(--font-sans)', fontWeight: 500, fontSize: 12,
  },
}

export default function Sidebar({ user, role }) {
  const location = useLocation()
  const navigate = useNavigate()
  const nav = getNav(role)
  const { club, isSuperAdmin, setClub } = useClub()

  const handleSignOut = async () => {
    try { await signOut(auth) } catch (err) { console.error('[Sidebar] signOut:', err) }
  }
  const handleSwitchClub = () => { setClub(''); navigate('/select-club') }

  return (
    <aside style={S.aside}>
      <div style={S.head}>
        <AirKiLockup size={22} color="#FFFFFF" />
      </div>

      <nav style={S.nav} aria-label="Sections">
        {nav.map(item => {
          const active = location.pathname === item.path || location.pathname.startsWith(item.path + '/')
          return (
            <button key={item.path} onClick={() => navigate(item.path)} style={S.item(active)} aria-current={active ? 'page' : undefined}>
              {item.label}
            </button>
          )
        })}
      </nav>

      <div style={S.foot}>
        {club && (
          <div>
            <div style={S.label}>Club</div>
            <div style={{ fontWeight: 600, fontSize: 13, color: '#FFFFFF' }}>{club.name || club.code}</div>
            <div style={S.mono}>{club.icao ? `${club.icao} · ` : ''}{club.code}</div>
            {isSuperAdmin && (
              <button onClick={handleSwitchClub} style={{ ...S.btn, marginTop: 6 }}>Switch club</button>
            )}
          </div>
        )}
        {user && (
          <div>
            <div style={S.label}>{ROLE_LABELS[role] ?? role}</div>
            <div style={{ fontSize: 12, color: '#FFFFFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                 title={user.email}>{user.displayName || user.email}</div>
          </div>
        )}
        <div style={S.mono} title={`Build ${BUILD_DATE}`}>
          {APP_CHANNEL} {APP_VERSION} · {BUILD_DATE}
        </div>
        <button onClick={handleSignOut} style={S.btn}>Sign out</button>
      </div>
    </aside>
  )
}
