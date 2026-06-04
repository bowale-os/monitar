from fastapi import APIRouter, status, HTTPException, Depends
from typing import List


from ..services.mongo_client import database
from .deps import get_current_user_id

r_router = APIRouter()


@r_router.get("/{session_id}", status_code=status.HTTP_200_OK)
async def get_session(session_id: str, current_user_id = Depends(get_current_user_id)):
    
    try: 
        session_data = await database.sessions.find_one({
            "_id": session_id,
            "user_id" : current_user_id
        })
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail="An error occurred while retrieving the session"
        )
    
    if not session_data:
        raise HTTPException(
            status_code=404,
            detail="Session not found"
        )

    return {
        "message":"This session was retrieved successfully",
        "data": session_data
        }


@r_router.get("/", status_code=status.HTTP_200_OK)
async def get_user_sessions(current_user_id = Depends(get_current_user_id)):
    
    try: 
        session_data = await database.sessions.find({
            "user_id" : current_user_id
        }).to_list(length=None)

    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail="An error occurred while retrieving this user's sessions"
        )

    return {
        "message":"Sessions was retrieved successfully",
        "data": session_data
        }



@r_router.delete("/{session_id}", status_code=status.HTTP_200_OK)
async def delete_session(
    session_id : str,
    current_user_id = Depends(get_current_user_id)
    ):
    
    try: 
        result = await database.sessions.delete_one({
            "_id" : session_id,
            "user_id" : current_user_id
        })

    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail="An error occurred while retrieving this user's sessions"
        )
    

    if result.deleted_count == 0:
        raise HTTPException(
            status_code=404,
            detail="Session not found hence was not deleted"
        )

    return {
        "message":"Session was deleted successfully",
        }
