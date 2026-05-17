from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from typing import Optional
import os

from app.api.auth import router

app = FastAPI(
)

app.include_router(router)

