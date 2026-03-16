"""Security middleware: headers, rate limiting, request size limits."""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

# Default maximum request body size: 1 MB.
DEFAULT_MAX_BODY_SIZE = 1_048_576


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add OWASP-recommended security headers to all responses."""

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-XSS-Protection"] = "1; mode=block"
        response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        response.headers["Content-Security-Policy"] = "default-src 'self'"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        return response


class RequestSizeLimitMiddleware(BaseHTTPMiddleware):
    """Reject requests with bodies exceeding a configurable size limit."""

    def __init__(self, app: object, max_body_size: int = DEFAULT_MAX_BODY_SIZE) -> None:
        super().__init__(app)  # type: ignore[arg-type]
        self.max_body_size = max_body_size

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        content_length = request.headers.get("content-length")
        if content_length is not None:
            try:
                length = int(content_length)
            except ValueError:
                return Response(status_code=400, content="Invalid Content-Length header")
            if length > self.max_body_size:
                return Response(
                    status_code=413,
                    content=f"Request body too large. Maximum size: {self.max_body_size} bytes",
                )
        return await call_next(request)


class RateLimitMiddleware(BaseHTTPMiddleware):
    """Simple in-memory rate limiter using a sliding window per client IP.

    This is suitable for single-process deployments. For multi-process or
    distributed deployments, use Redis-backed rate limiting instead.
    """

    def __init__(
        self,
        app: object,
        requests_per_minute: int = 60,
    ) -> None:
        super().__init__(app)  # type: ignore[arg-type]
        self.requests_per_minute = requests_per_minute
        self._window: dict[str, list[float]] = {}

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        import time

        client_ip = request.client.host if request.client else "unknown"
        now = time.monotonic()
        window_start = now - 60.0

        # Get or create the request log for this IP
        timestamps = self._window.get(client_ip, [])
        # Prune old entries outside the window
        timestamps = [t for t in timestamps if t > window_start]

        if len(timestamps) >= self.requests_per_minute:
            return Response(
                status_code=429,
                content="Rate limit exceeded. Try again later.",
                headers={"Retry-After": "60"},
            )

        timestamps.append(now)
        self._window[client_ip] = timestamps
        return await call_next(request)
