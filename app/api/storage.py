from fastapi import APIRouter, status, HTTPException, Depends
from pydantic import BaseModel, EmailStr
from datetime import datetime, timezone
from typing import List


from ..services.mongo_client import database
from ..security import hash_password, create_access_token, verify_password, verify_access_token
from ..models import Tab, Session
from .deps import get_current_user_id

s_router = APIRouter()


@s_router.post("/store", status_code=status.HTTP_201_CREATED)
async def store(payload: Session,
                current_user_id = Depends(get_current_user_id)):
    
    data = payload.model_dump()
    data["user_id"] = current_user_id

    await database.sessions.insert_one(data)

    return {"message":"This session was stored successfully"}


