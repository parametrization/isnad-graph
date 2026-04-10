"""Authentication — JWT validation via user-service JWKS and auth models.

Relocated from ``src.auth`` as part of the user-service extraction. The old
``src/auth/`` directory contained OAuth providers, sessions, tokens, 2FA, and
verification code that has been migrated to user-service.  Only the JWKS
validation and shared models remain and now live here.
"""

from __future__ import annotations

import logging
import time
from enum import StrEnum

import httpx
from jose import JWTError, jwt
from pydantic import BaseModel, ConfigDict

from src.config import get_settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Auth models
# ---------------------------------------------------------------------------


class Role(StrEnum):
    """User roles with hierarchical privilege levels."""

    VIEWER = "viewer"
    EDITOR = "editor"
    MODERATOR = "moderator"
    ADMIN = "admin"


ROLE_HIERARCHY: dict[Role, int] = {
    Role.VIEWER: 0,
    Role.EDITOR: 1,
    Role.MODERATOR: 2,
    Role.ADMIN: 3,
}


class User(BaseModel):
    """Authenticated user context built from user-service JWT claims."""

    model_config = ConfigDict(frozen=True)

    id: str
    email: str
    name: str
    role: str | None = None
    is_admin: bool = False
    subscription_status: str | None = None


# ---------------------------------------------------------------------------
# JWKS-based RS256 JWT validation
# ---------------------------------------------------------------------------

# Module-level JWKS cache
_jwks_cache: dict[str, object] | None = None
_jwks_fetched_at: float = 0.0


def _get_jwks_url() -> str:
    """Return the JWKS endpoint URL for user-service."""
    base = get_settings().auth.user_service_url.rstrip("/")
    return f"{base}/.well-known/jwks.json"


def fetch_jwks() -> dict[str, object]:
    """Fetch JWKS from user-service, using a TTL-based in-memory cache.

    Raises ``httpx.HTTPError`` if the JWKS endpoint is unreachable.
    """
    global _jwks_cache, _jwks_fetched_at  # noqa: PLW0603
    ttl = get_settings().auth.user_service_jwks_cache_ttl
    now = time.monotonic()
    if _jwks_cache is not None and (now - _jwks_fetched_at) < ttl:
        return _jwks_cache

    url = _get_jwks_url()
    resp = httpx.get(url, timeout=10.0)
    resp.raise_for_status()
    _jwks_cache = resp.json()
    _jwks_fetched_at = now
    return _jwks_cache


def invalidate_jwks_cache() -> None:
    """Force the next ``fetch_jwks`` call to re-fetch from user-service."""
    global _jwks_cache, _jwks_fetched_at  # noqa: PLW0603
    _jwks_cache = None
    _jwks_fetched_at = 0.0


def verify_user_service_token(token: str) -> dict[str, object]:
    """Validate an RS256 JWT issued by user-service using its JWKS.

    On signature failure, invalidates the JWKS cache and retries once to
    handle key rotation gracefully (see RFC 7517 section 5).

    Returns the decoded payload on success.

    Raises:
        ValueError: If the token is invalid, expired, or has a bad signature.
        httpx.HTTPError: If the JWKS endpoint is unreachable.
    """
    jwks = fetch_jwks()
    try:
        payload: dict[str, object] = jwt.decode(
            token,
            jwks,
            algorithms=["RS256"],
        )
    except JWTError:
        # Key rotation may have occurred — invalidate cache and retry once
        logger.info("JWKS verification failed, invalidating cache and retrying")
        invalidate_jwks_cache()
        jwks = fetch_jwks()
        try:
            payload = jwt.decode(
                token,
                jwks,
                algorithms=["RS256"],
            )
        except JWTError as exc:
            raise ValueError(f"Invalid token: {exc}") from exc
    return payload
