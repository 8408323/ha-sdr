from __future__ import annotations

import secrets
from pathlib import Path

from fastapi import Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

DATA_TOKEN_PATH = Path("/data/api_token")
security = HTTPBearer()


def resolve_api_token(configured: str) -> tuple[str, bool]:
    """Returns (token, freshly_generated). A configured token always wins over a stored one."""
    configured = (configured or "").strip()
    if configured:
        return configured, False
    if DATA_TOKEN_PATH.exists():
        return DATA_TOKEN_PATH.read_text().strip(), False
    token = secrets.token_hex(32)
    DATA_TOKEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    DATA_TOKEN_PATH.write_text(token)
    DATA_TOKEN_PATH.chmod(0o600)
    return token, True


async def verify_token(request: Request, credentials: HTTPAuthorizationCredentials = Depends(security)) -> None:
    """FastAPI dependency: raises 401 unless the bearer token matches the add-on's API token."""
    if credentials.credentials != request.app.state.api_token:
        raise HTTPException(status_code=401, detail="invalid token")
