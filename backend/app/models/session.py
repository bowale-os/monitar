from pydantic import BaseModel, ConfigDict, Field
from datetime import datetime, timezone
from typing import List, Optional
from .tab import Tab

class BaseSchema(BaseModel):
    model_config = ConfigDict(
        json_encoders={datetime: lambda v: v.isoformat().replace("+00:00", "Z")}
    )

class Session(BaseSchema):
    intent: Optional[str] = None
    started_at: Optional[datetime] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    content_encrypted: Optional[str] = None
    content_hash: Optional[str] = None
    embedding: Optional[List[float]] = None
    tab_count: Optional[int] = None
    window_count: Optional[int] = None