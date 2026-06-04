from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi import Depends, HTTPException, status


from ..security import verify_access_token, TokenExpireError, TokenInvalidError
from ..services.mongo_client import database

token_getter = HTTPBearer()

def get_current_user_id(
    credentials: HTTPAuthorizationCredentials = Depends(token_getter)) -> dict:

    """
    Get the current user from access_token (for protected routes)
    """

    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )

    try:
        user_id = verify_access_token(credentials.credentials)
    except (TokenExpireError, TokenInvalidError):
        raise credentials_exception

    return user_id

