from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi import Depends, HTTPException, status


from ..security import verify_access_token, TokenExpireError, TokenInvalidError
from ..services.mongo_client import database

token_getter = HTTPBearer()

def get_current_user_id(
    credentials: HTTPAuthorizationCredentials = Depends(token_getter)) -> dict:

    """
    Get the current user from access_token (for protected routes)

    Despite the `dict` annotation, this returns the user id string (the JWT
    `sub`). Routes put it straight into their Mongo filters, so ownership is
    always taken from the verified token and never from the request body.
    """

    # Expired and malformed tokens deliberately get the same response, so a
    # caller learns nothing beyond "re-authenticate".
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

