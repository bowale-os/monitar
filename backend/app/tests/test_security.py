from datetime import datetime, timezone, timedelta

import pytest
from jose import jwt

import backend.app.security as security


def test_hash_password():
    """hash_password returns a verifiable hash distinct from the input."""
    password = "R3@5479yc5"
    hashed = security.hash_password(password)
    assert password != hashed
    assert security.verify_password(password, hashed)
    assert not security.verify_password("wrong-password", hashed)


def test_access_token_roundtrip():
    """A freshly minted access token decodes back to the same user_id."""
    user_id = "_929302838h9@2$"
    token = security.create_access_token(user_id)
    assert user_id == security.verify_access_token(token)


def test_expired_access_token_raises():
    """An access token whose exp is in the past raises TokenExpireError."""
    past = datetime.now(timezone.utc) - timedelta(minutes=1)
    token = jwt.encode(
        {"sub": "u1", "exp": past, "type": "access"},
        security.SECRET_KEY,
        algorithm=security.ALGORITHM,
    )
    with pytest.raises(security.TokenExpireError):
        security.verify_access_token(token)


def test_garbage_access_token_raises():
    """A malformed/bad-signature token raises TokenInvalidError."""
    with pytest.raises(security.TokenInvalidError):
        security.verify_access_token("not.a.real.token")


def test_refresh_token_hash_is_stable_and_unique():
    """hash is deterministic, matches create output, and raw tokens differ."""
    raw1, hash1 = security.create_refresh_token()
    raw2, hash2 = security.create_refresh_token()

    assert raw1 != raw2
    assert hash1 != hash2
    # Hashing the raw token reproduces the stored hash (enables lookup).
    assert hash1 == security.hash_refresh_token(raw1)
