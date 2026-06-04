from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel
from typing import Optional
import os

from backend.app.api import main_router

app = FastAPI(
)

app.include_router(main_router)

