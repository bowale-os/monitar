from pydantic import BaseModel
from datetime import datetime

class User(BaseModel):
    email: str
    name: str
    picture: str | None = None
    created_at: datetime