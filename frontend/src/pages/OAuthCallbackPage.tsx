import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { API_BASE } from '../config'

export default function OAuthCallbackPage() {
  const { provider } = useParams<{ provider: string }>()
  const navigate = useNavigate()
  const { refreshAuthState } = useAuth()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    const state = params.get('state')

    if (!code || !provider) {
      setError('Missing authorization code or provider.')
      return
    }

    // Validate state against what was stored during the login redirect
    const storedState = sessionStorage.getItem('oauth_state')
    if (storedState && state !== storedState) {
      setError('OAuth state mismatch. Please try logging in again.')
      return
    }

    let cancelled = false

    async function handleCallback() {
      try {
        const res = await fetch(
          `${API_BASE}/auth/callback/${encodeURIComponent(provider!)}?code=${encodeURIComponent(code!)}&state=${encodeURIComponent(state ?? '')}`,
          { credentials: 'include' },
        )

        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(body?.detail ?? `Authentication failed (${res.status})`)
        }

        // Backend has set httpOnly cookies — now recheck auth state
        await refreshAuthState()

        // Clean up sessionStorage
        sessionStorage.removeItem('oauth_provider')
        sessionStorage.removeItem('oauth_state')

        if (!cancelled) {
          navigate('/', { replace: true })
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Authentication failed')
        }
      }
    }

    handleCallback()

    return () => {
      cancelled = true
    }
  }, [provider, refreshAuthState, navigate])

  if (error) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          height: '100vh',
          gap: '1rem',
        }}
      >
        <p role="alert">{error}</p>
        <a href="/login">Back to login</a>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh' }}>
      <div role="status" aria-label="Completing login">
        Processing login...
      </div>
    </div>
  )
}
