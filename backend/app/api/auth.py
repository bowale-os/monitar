from fastapi import APIRouter, status, HTTPException
from pydantic import BaseModel, EmailStr, Field
from datetime import datetime, timezone, timedelta
from pymongo.errors import DuplicateKeyError
import os, base64

from ..services.mongo_client import database
from ..security import (
    hash_password,
    verify_password,
    create_access_token,
    create_refresh_token,
    hash_refresh_token,
    REFRESH_TOKEN_EXPIRE_DAYS,
)

a_router = APIRouter()

##-------------SCHEMAS-----------##
class SignUpRequest(BaseModel):
    name: str
    email: EmailStr
    # bcrypt caps at 72 bytes; reject weak/oversized passwords before hashing.
    password: str = Field(min_length=8, max_length=72)

class SignInRequest(BaseModel):
    email: EmailStr
    password: str

class RefreshRequest(BaseModel):
    refresh_token: str


##-------------HELPERS-----------##
async def issue_refresh_token(user_id: str) -> str:
    """Create a refresh token, persist its hash, and return the raw token."""
    raw_token, token_hash = create_refresh_token()
    await database.refresh_tokens.insert_one({
        "user_id": user_id,
        "token_hash": token_hash,
        "created_at": datetime.now(timezone.utc),
        "expires_at": datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
    })
    return raw_token


@a_router.post("/sign-up", status_code=status.HTTP_201_CREATED)
async def sign_up(request: SignUpRequest):
    
    salt = base64.b64encode(os.urandom(16)).decode()
    data = request.model_dump()

    hashed_password = hash_password(data["password"])
    data["password"] = hashed_password
    data["created_at"] = datetime.now(timezone.utc)
    data["enc_salt"] = salt


    # The unique index on users.email is the real guard; the try/except turns a
    # duplicate (including a concurrent-signup race) into a clean 400.
    try:
        result = await database.users.insert_one(data)
    except DuplicateKeyError:
        raise HTTPException(status_code=400, detail="Email already registered")

    user_id = str(result.inserted_id)
    access_token = create_access_token(user_id)
    refresh_token = await issue_refresh_token(user_id)

    return {
        "message": "You signed up successfully",
        "access_token": access_token,
        "refresh_token": refresh_token,
        "enc_salt": salt
    }


@a_router.post("/sign-in", status_code=status.HTTP_202_ACCEPTED)
async def sign_in(request: SignInRequest):
    data = request.model_dump()

    existing_user = await database.users.find_one({"email": data["email"]})

    # Identical error for "no such email" and "wrong password" so an attacker
    # can't enumerate which emails are registered.
    invalid_credentials = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid email or password",
    )

    if not existing_user:
        raise invalid_credentials

    if not verify_password(data["password"], existing_user["password"]):
        raise invalid_credentials

    user_id = str(existing_user["_id"])
    access_token = create_access_token(user_id)
    refresh_token = await issue_refresh_token(user_id)

    return {
        "message": "You logged in successfully",
        "user_data": {
            "id": user_id,
            "email": existing_user["email"],
            "name": existing_user["name"],
        },
        "enc_salt": existing_user["enc_salt"],
        "access_token": access_token,
        "refresh_token": refresh_token,
    }


@a_router.post("/refresh", status_code=status.HTTP_200_OK)
async def refresh(request: RefreshRequest):
    """
    Rotate the refresh token: validate it, delete it, and issue a fresh
    access + refresh pair. Reusing an already-rotated token fails (it's gone).
    """
    token_hash = hash_refresh_token(request.refresh_token)

    # Atomically consume the token: only one rotation can win.
    record = await database.refresh_tokens.find_one_and_delete({"token_hash": token_hash})

    invalid_token = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid or expired refresh token",
    )

    if not record:
        raise invalid_token

    # TTL index also purges these, but check defensively in case it hasn't run.
    expires_at = record["expires_at"]
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if datetime.now(timezone.utc) > expires_at:
        raise invalid_token

    user_id = record["user_id"]
    user = await database.users.find_one({"_id": user_id})

    access_token = create_access_token(user_id)
    refresh_token = await issue_refresh_token(user_id)

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "enc_salt": user["enc_salt"]
    }


@a_router.post("/logout", status_code=status.HTTP_200_OK)
async def logout(request: RefreshRequest):
    """Revoke the presented refresh token server-side."""
    token_hash = hash_refresh_token(request.refresh_token)
    await database.refresh_tokens.delete_one({"token_hash": token_hash})
    return {"message": "Logged out"}
