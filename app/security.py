#create access token function
#verify access token function
#create hash password fuunction
#create verify hash function

from jose import jws
from dotenv import load_dotenv
import bcrypt
import os

load_dotenv()

SECRET_KEY = os.getenv("SECRET_KEY")
ALGORITHM = os.getenv("ALGORITHM")


def hash_password(password: str) -> str:
    """
    hashes passwords from the sign-up route in auth.py
    """

    password_bytes = password.encode('utf-8')
    hashed_password = bcrypt.hashpw(password_bytes, bcrypt.gensalt(rounds=8))

    return hashed_password


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

    user_id_bytes = user_id.encode('utf-8')
    token = jws.sign(payload=user_id_bytes, key=SECRET_KEY, algorithm=ALGORITHM)

    return token


def verify_access_token(access_token:str) -> str:
    """
    convert token from frontend to user_id for security checks
    """

    user_id = jws.verify(token=access_token, key=SECRET_KEY, algorithms=ALGORITHM)
    return user_id


