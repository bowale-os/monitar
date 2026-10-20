from fastapi import APIRouter, status, HTTPException, Depends
import uuid

from ..services.mongo_client import database
from ..models import Session
from .deps import get_current_user_id

s_router = APIRouter()


@s_router.post("/store", status_code=status.HTTP_201_CREATED)
async def store(payload: Session,
                current_user_id = Depends(get_current_user_id)):
    
    data = payload.model_dump()
    # _id and user_id are always assigned server-side, so a client cannot choose
    # its own id or write into another user's account. content_encrypted is
    # stored exactly as received; the server never sees the plaintext.
    session_id = uuid.uuid4()

    data["_id"] = str(session_id)
    data["user_id"] = current_user_id

    await database.sessions.insert_one(data)

    return {
        "message":"This session was stored successfully",
        "id": data["_id"]
        }



@s_router.put("/{session_id}")
async def update_session(
    request: Session,
    session_id: str,
    current_user_id = Depends(get_current_user_id)
):

    # The extension re-sends the whole envelope on every autosave, so this is a
    # full overwrite of the Session fields rather than a partial patch. created_at
    # is excluded because model_dump() would regenerate it as "now" and clobber the
    # original; updated_at is meant to refresh on every save, so it stays.
    result = await database.sessions.update_one(
        {"_id": session_id, "user_id": current_user_id},   # 1. which doc to match
        {"$set": request.model_dump(exclude={"created_at"})}                     # 2. what to change
    )

    if result.matched_count == 0:
        raise HTTPException(
            status_code=404,
            detail="Session was not found"
        )

    return {
        "message": "Session was updated successfully"
        }



