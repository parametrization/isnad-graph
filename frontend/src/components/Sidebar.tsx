import { NavLink } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

const navItems = [
  { to: '/narrators', label: 'Narrators' },
  { to: '/hadiths', label: 'Hadiths' },
  { to: '/collections', label: 'Collections' },
  { to: '/search', label: 'Search' },
  { to: '/timeline', label: 'Timeline' },
  { to: '/compare', label: 'Compare' },
  { to: '/graph', label: 'Graph Explorer' },
]

export default function Sidebar() {
  const { user, isAdmin, signOut } = useAuth()

  return (
    <nav
      aria-label="Main navigation"
      style={{
        width: 220,
        padding: 'var(--spacing-4)',
        borderInlineEnd: 'var(--border-width-thin) solid var(--color-border)',
        background: 'var(--color-card)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <ul style={{ listStyle: 'none', padding: 0, margin: 0, flex: 1 }}>
        {navItems.map((item) => (
          <li key={item.to} style={{ marginBottom: 'var(--spacing-2)' }}>
            <NavLink
              to={item.to}
              style={({ isActive }) => ({
                textDecoration: 'none',
                fontWeight: isActive ? 700 : 400,
                color: isActive ? 'var(--color-primary)' : 'var(--color-foreground)',
                fontFamily: 'var(--font-body)',
                fontSize: 'var(--text-sm)',
                display: 'block',
                padding: 'var(--spacing-1_5) var(--spacing-3)',
                borderRadius: 'var(--radius-md)',
                background: isActive ? 'var(--color-accent)' : 'transparent',
                transition: 'background-color var(--duration-fast) var(--ease-default)',
              })}
            >
              {item.label}
            </NavLink>
          </li>
        ))}
        {isAdmin && (
          <li
            style={{
              marginTop: 'var(--spacing-4)',
              paddingTop: 'var(--spacing-4)',
              borderTop: 'var(--border-width-thin) solid var(--color-border)',
            }}
          >
            <NavLink
              to="/admin"
              style={({ isActive }) => ({
                textDecoration: 'none',
                fontWeight: isActive ? 700 : 400,
                color: isActive ? 'var(--color-primary)' : 'var(--color-foreground)',
                fontFamily: 'var(--font-body)',
                fontSize: 'var(--text-sm)',
                display: 'block',
                padding: 'var(--spacing-1_5) var(--spacing-3)',
                borderRadius: 'var(--radius-md)',
                background: isActive ? 'var(--color-accent)' : 'transparent',
              })}
            >
              Admin Dashboard
            </NavLink>
          </li>
        )}
      </ul>

      {user && (
        <div
          style={{
            paddingTop: 'var(--spacing-4)',
            borderTop: 'var(--border-width-thin) solid var(--color-border)',
          }}
        >
          <div
            style={{
              fontSize: 'var(--text-xs)',
              color: 'var(--color-muted-foreground)',
              marginBottom: 'var(--spacing-2)',
              paddingInline: 'var(--spacing-3)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={user.email}
          >
            {user.name || user.email}
          </div>
          <button
            onClick={signOut}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--spacing-2)',
              padding: 'var(--spacing-1_5) var(--spacing-3)',
              borderRadius: 'var(--radius-md)',
              border: 'none',
              background: 'transparent',
              color: 'var(--color-foreground)',
              fontFamily: 'var(--font-body)',
              fontSize: 'var(--text-sm)',
              cursor: 'pointer',
              transition: 'background-color var(--duration-fast) var(--ease-default)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-accent)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent'
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign out
          </button>
        </div>
      )}
    </nav>
  )
}
