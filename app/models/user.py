from pydantic import BaseModel
from datetime import datetime

class User(BaseModel):
    google_id: str
    email: str
    name: str
    picture: str | None = None
    created_at: datetime