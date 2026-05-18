from jose import jws
from dotenv import load_dotenv
from datetime import datetime, timezone, timedelta
import bcrypt
import json
import os

load_dotenv()

SECRET_KEY: str = os.getenv("SECRET_KEY")
ALGORITHM: str = os.getenv("ALGORITHM")
TOKEN_EXPIRY: int = int(os.getenv("ACCESS_TOKEN_EXPIRE_DAYS"))

class TokenExpireError(Exception):
    "Token has expired"


def hash_password(password: str) -> str:
    """
    hashes passwords from the sign-up route in auth.py
    """

    password_bytes = password.encode('utf-8')
    hashed_password = bcrypt.hashpw(password_bytes, bcrypt.gensalt(rounds=8))

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
    takes user_id from sign-up and sign-in and returns access token
    """

    payload = {
        "user_id" : user_id,
        "exp" : (datetime.now(timezone.utc) + timedelta(days=TOKEN_EXPIRY)).isoformat()
    }

    payload_bytes = json.dumps(payload).encode('utf-8')
    token = jws.sign(payload=payload_bytes, key=SECRET_KEY, algorithm=ALGORITHM)

    return token


def verify_access_token(access_token:str) -> str:
    """
    convert token from frontend to user_id for security checks
    """

    payload_bytes = jws.verify(token=access_token, key=SECRET_KEY, algorithms=ALGORITHM)
    payload = json.loads(payload_bytes.decode('utf-8'))

    exp = datetime.fromisoformat(payload["exp"])

    if datetime.now(timezone.utc) > exp:
        raise TokenExpireError
    
    return payload["user_id"]


