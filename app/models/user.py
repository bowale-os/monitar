from pydantic import BaseModel, EmailStr
from datetime import datetime

class User(BaseModel):
    email: EmailStr
    name: str
    picture: str | None = None
    created_at: datetime