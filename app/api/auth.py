from fastapi import APIRouter
from pydantic import BaseModel


from ..services.mongo_client import mongo_client

router = APIRouter()

##-------------SCHEMAS-----------##
class SignUpRequest(BaseModel):
    name: str
    email: str



@router.post("/sign-up")
async def sign_up(request: SignUpRequest):
    data = request.model_dump()


    # make access token, and use password
    database = mongo_client["monitar"]
    await database.create_collection("users")
    await database.users.insert_one(data)

    return {"message":"success"}
