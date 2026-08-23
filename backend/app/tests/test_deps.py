from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from jose import jwt

import backend.app.security as security
from backend.app.api.deps import get_current_user_id


def _creds(token: str) -> HTTPAuthorizationCredentials:
    return HTTPAuthorizationCredentials(scheme="Bearer", credentials=token)


def test_valid_token_returns_user_id():
    token = security.create_access_token("user-123")
    assert get_current_user_id(_creds(token)) == "user-123"


def test_expired_token_raises_401():
    past = datetime.now(timezone.utc) - timedelta(minutes=1)
    token = jwt.encode(
        {"sub": "u1", "exp": past, "type": "access"},
        security.SECRET_KEY,
        algorithm=security.ALGORITHM,
    )
    with pytest.raises(HTTPException) as exc_info:
        get_current_user_id(_creds(token))
    assert exc_info.value.status_code == 401
    assert exc_info.value.headers["WWW-Authenticate"] == "Bearer"


def test_malformed_token_raises_401():
    with pytest.raises(HTTPException) as exc_info:
        get_current_user_id(_creds("not.a.real.token"))
    assert exc_info.value.status_code == 401


def test_refresh_type_token_used_as_access_token_raises_401():
    # A syntactically valid, correctly-signed JWT whose "type" claim isn't
    # "access" must still be rejected -- exercises deps.py's handling of
    # security.py's type-check branch (payload.get("type") != "access").
    now = datetime.now(timezone.utc)
    token = jwt.encode(
        {"sub": "u1", "iat": now, "exp": now + timedelta(minutes=15), "type": "refresh"},
        security.SECRET_KEY,
        algorithm=security.ALGORITHM,
    )
    with pytest.raises(HTTPException) as exc_info:
        get_current_user_id(_creds(token))
    assert exc_info.value.status_code == 401


def test_no_auth_header_returns_401(client):
    # This installed FastAPI version's HTTPBearer.make_not_authenticated_error
    # raises 401 (not the older-generation default of 403) for a missing
    # header -- same status as a present-but-invalid token, verified below.
    resp = client.get("/")
    assert resp.status_code == 401


def test_wrong_auth_scheme_returns_401(client):
    resp = client.get("/", headers={"Authorization": "Basic dXNlcjpwYXNz"})
    assert resp.status_code == 401


def test_bearer_scheme_with_no_token_returns_401(client):
    resp = client.get("/", headers={"Authorization": "Bearer"})
    assert resp.status_code == 401


def test_bearer_scheme_with_garbage_token_returns_401(client):
    resp = client.get("/", headers={"Authorization": "Bearer garbage-token"})
    assert resp.status_code == 401
