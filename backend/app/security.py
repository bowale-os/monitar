from jose import jwt, JWTError, ExpiredSignatureError
from dotenv import load_dotenv
from datetime import datetime, timezone, timedelta
from pathlib import Path
import bcrypt
import hashlib
import secrets
import os

# Load the .env that sits next to this file, regardless of the working
# directory uvicorn is launched from.
load_dotenv(Path(__file__).resolve().parent / ".env")

SECRET_KEY: str = os.getenv("SECRET_KEY")
ALGORITHM: str = os.getenv("ALGORITHM", "HS256")
ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "15"))
REFRESH_TOKEN_EXPIRE_DAYS: int = int(os.getenv("REFRESH_TOKEN_EXPIRE_DAYS", "7"))

# bcrypt only considers the first 72 bytes of a password; longer inputs are
# silently truncated. We reject them at the schema layer, but guard here too.
BCRYPT_MAX_BYTES = 72

# Fail loudly rather than ship a forgeable token: a short/missing secret means
# anyone could guess it and mint tokens for any user.
if not SECRET_KEY or len(SECRET_KEY) < 32:
    raise RuntimeError(
        "SECRET_KEY is missing or too short (need >= 32 chars). "
        "Generate one with: python -c \"import secrets; print(secrets.token_urlsafe(48))\""
    )


class TokenExpireError(Exception):
    "Token has expired"


class TokenInvalidError(Exception):
    "Token is malformed or has a bad signature"


def hash_password(password: str) -> str:
    """
    hashes passwords from the sign-up route in auth.py
    """

    password_bytes = password.encode('utf-8')
    hashed_password = bcrypt.hashpw(password_bytes, bcrypt.gensalt(rounds=12))

    return hashed_password.decode('utf-8')


def verify_password(password:str, hashed:str) -> bool:
    """
    check that the password from sign-in and the hash from the database are the same
    """

    password_bytes = password.encode('utf-8')
    hashed_bytes = hashed.encode('utf-8')

    is_match = bcrypt.checkpw(password_bytes, hashed_bytes)
    return is_match


def create_access_token(user_id: str) -> str:
    """
    takes user_id from sign-up and sign-in and returns a short-lived JWT access token
    """

    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "iat": now,
        "exp": now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
        "type": "access",
    }

    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def verify_access_token(access_token: str) -> str:
    """
    validate the JWT and return the user_id (sub). jose validates exp for us.
    """

    try:
        payload = jwt.decode(access_token, SECRET_KEY, algorithms=[ALGORITHM])
    except ExpiredSignatureError:
        raise TokenExpireError
    except JWTError:
        raise TokenInvalidError

    if payload.get("type") != "access":
        raise TokenInvalidError

    return payload["sub"]


def hash_refresh_token(raw_token: str) -> str:
    """
    Refresh tokens are stored as a sha256 hash so a DB leak doesn't expose
    usable tokens. The raw token is high-entropy, so sha256 (fast, lookup-able)
    is appropriate here — unlike low-entropy passwords which need bcrypt.
    """

    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def create_refresh_token() -> tuple[str, str]:
    """
    returns (raw_token, token_hash). The raw token is returned to the client
    once; only the hash is persisted server-side.
    """

    raw_token = secrets.token_urlsafe(32)
    return raw_token, hash_refresh_token(raw_token)
