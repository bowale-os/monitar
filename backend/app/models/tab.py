from pydantic import BaseModel
from datetime import datetime


class Tab(BaseModel):
    url: str
    title: str
    opened_at: datetime
    time_spent: int
    time_since_prev: int
    is_last_opened: bool
