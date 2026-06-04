from contextlib import asynccontextmanager
from fastapi import FastAPI

from .api import main_router
from .services.mongo_client import init_indexes


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure DB indexes (unique email, refresh-token indexes) exist on startup.
    await init_indexes()
    yield


app = FastAPI(title="Monitar", lifespan=lifespan)

app.include_router(main_router)
