from fastapi import APIRouter, status, HTTPException
from pydantic import BaseModel, EmailStr
from datetime import datetime, timezone


from ..services.mongo_client import database
from ..security import hash_password, create_access_token, verify_password, verify_access_token

a_router = APIRouter()

##-------------SCHEMAS-----------##
class SignUpRequest(BaseModel):
    name: str
    email: EmailStr 
    password: str

class SignInRequest(BaseModel):
    email: EmailStr
    password: str


@a_router.post("/sign-up", status_code=status.HTTP_201_CREATED)
async def sign_up(request: SignUpRequest):
    data = request.model_dump()

    email = data["email"]

    #check database if the email is already used
    existing_user = await database.users.find_one({"email": email})
    
    if existing_user:
        raise HTTPException(status_code=400, detail="Email already registered")

    #if not then proceed to hash password and write it to database
    if not existing_user:
        hashed_password = hash_password(data["password"])
        data["password"] = hashed_password

    data["created_at"] = datetime.now(timezone.utc)
    result = await database.users.insert_one(data)

    #make access token, return to frontend
    access_token = create_access_token(str(result.inserted_id))

    return {"message":"You signed up successfully", "access_token":access_token}


@a_router.post("/sign-in", status_code=status.HTTP_202_ACCEPTED)
async def sign_in(request: SignInRequest):
    data = request.model_dump()

    email = data["email"]

    #check database if the email matches any user
    existing_user = await database.users.find_one({"email": email})
    
    if not existing_user:
        raise HTTPException(status_code=400, detail="Email was not found")

    #if so, proceed to verify password with the hashed password in db
    password = data["password"]
    is_match = verify_password(password, existing_user["password"])

    if not is_match:
        raise HTTPException(status_code=400, detail="Password is incorrect")
    
    access_token = create_access_token(str(existing_user["_id"]))
    return {
        "message": "You logged in successfully",
        "user_data": {
            "id": str(existing_user["_id"]),
            "email": existing_user["email"],
            "name": existing_user["name"],
        },
        "access_token": access_token
    }
