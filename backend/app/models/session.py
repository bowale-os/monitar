from pydantic import BaseModel, field_validator
from datetime import datetime, timezone
from typing import List
from .tab import Tab

class Session(BaseModel):
    intent: str
    started_at: datetime
    stopped_at: datetime
    tabs: List[Tab]

    @field_validator('started_at', 'stopped_at')
    @classmethod
    def ensure_utc(cls, v):
        if v.tzinfo is None:
            return v.replace(tzinfo=timezone.utc)
        return v