import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { createElement } from 'react'

export type UserRole = 'viewer' | 'editor' | 'moderator' | 'admin'

export interface AuthUser {
  id: string
  email: string
  name: string
  is_admin: boolean
  provider: string
  role: UserRole | null
}

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  isAdmin: boolean
  role: UserRole
  hasRole: (minRole: UserRole) => boolean
  logout: () => void
  signOut: () => Promise<void>
}

const ROLE_HIERARCHY: Record<UserRole, number> = {
  viewer: 0,
  editor: 1,
  moderator: 2,
  admin: 3,
}

const API_BASE = '/api/v1'

const AuthContext = createContext<AuthContextValue | null>(null)

async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = localStorage.getItem('refresh_token')
  if (!refreshToken) return null

  try {
    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${refreshToken}`,
      },
    })

    if (!res.ok) return null

    const data = await res.json()
    localStorage.setItem('access_token', data.access_token)
    if (data.refresh_token) {
      localStorage.setItem('refresh_token', data.refresh_token)
    }
    return data.access_token as string
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [loading, setLoading] = useState(true)

  const clearTokensAndRedirect = useCallback(() => {
    localStorage.removeItem('access_token')
    localStorage.removeItem('refresh_token')
    setUser(null)
    if (window.location.pathname !== '/login') {
      window.location.href = '/login'
    }
  }, [])

  const logout = useCallback(() => {
    const token = localStorage.getItem('access_token')
    if (token) {
      fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {})
    }
    clearTokensAndRedirect()
  }, [clearTokensAndRedirect])

  useEffect(() => {
    async function loadUser() {
      let token = localStorage.getItem('access_token')
      if (!token) {
        setLoading(false)
        return
      }

      let res = await fetch(`${API_BASE}/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      // If access token expired, try refreshing
      if (res.status === 401) {
        token = await refreshAccessToken()
        if (!token) {
          clearTokensAndRedirect()
          setLoading(false)
          return
        }
        res = await fetch(`${API_BASE}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      }

      if (res.ok) {
        const data: AuthUser = await res.json()
        setUser(data)
      } else {
        setUser(null)
      }
      setLoading(false)
    }

    loadUser()
  }, [clearTokensAndRedirect])

  const signOut = useCallback(async () => {
    const token = localStorage.getItem('access_token')

    // Call logout endpoint (best-effort — clear tokens regardless)
    if (token) {
      try {
        await fetch(`${API_BASE}/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        })
      } catch {
        // Ignore network errors — we still clear local state
      }
    }

    localStorage.removeItem('access_token')
    localStorage.removeItem('refresh_token')
    setUser(null)

    window.location.href = '/login'
  }, [])

  const userRole: UserRole = user?.role ?? 'viewer'

  const hasRole = useCallback(
    (minRole: UserRole): boolean => {
      return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[minRole]
    },
    [userRole],
  )

  const value: AuthContextValue = {
    user,
    loading,
    isAdmin: user?.is_admin ?? false,
    role: userRole,
    hasRole,
    logout,
    signOut,
  }

  return createElement(AuthContext.Provider, { value }, children)
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (ctx === null) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return ctx
}
