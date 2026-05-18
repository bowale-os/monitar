from fastapi import APIRouter, status
from pydantic import BaseModel, EmailStr


from ..services.mongo_client import database
from security import hash_password, create_access_token

router = APIRouter()

##-------------SCHEMAS-----------##
class SignUpRequest(BaseModel):
    name: str
    email: EmailStr 
    password: str



@router.post("/sign-up", status_code=status.HTTP_201_CREATED)
async def sign_up(request: SignUpRequest):
    data = request.model_dump()

    email = data["email"]

    #check database if the email is already used
    existing_user = await database.users.find_one({"email": email})
    
    #if not then proceed to hash password and write it to database
    if not existing_user:
        hashed_password = hash_password(data["password"])
        data["password"] = hashed_password

    result = await database.users.insert_one(data)

    #make access token, return to frontend
    access_token = create_access_token(result.inserted_id)

    return {"message":"success", "access_token":access_token}
