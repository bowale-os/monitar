from pydantic import BaseModel
from datetime import datetime
from typing import List
from .tab import Tab

class Session(BaseModel):
    user_id: str
    intent: str
    started_at: datetime
    stopped_at: datetime
    tabs: List[Tab]