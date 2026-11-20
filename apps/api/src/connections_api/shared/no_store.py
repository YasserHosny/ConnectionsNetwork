"""`Cache-Control: no-store` on every API response.

API responses carry contact values and other personal data. A browser on a shared device, the
service worker or a CDN in front of the app must not keep a copy. Nginx sets the same header on
/api/ (infra/nginx/nginx.conf); this middleware is the API's own copy, defence in depth for a
deployment that bypasses or misconfigures the proxy. An endpoint's own Cache-Control is replaced.
"""

from __future__ import annotations

from starlette.datastructures import MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

NO_STORE = "no-store"


class NoStoreMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_no_store(message: Message) -> None:
            if message["type"] == "http.response.start":
                MutableHeaders(scope=message)["Cache-Control"] = NO_STORE
            await send(message)

        await self.app(scope, receive, send_no_store)
