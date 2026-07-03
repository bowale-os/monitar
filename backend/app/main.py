from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
<<<<<<< HEAD
from fastapi.responses import FileResponse
=======
>>>>>>> 241e225 (temp changes to onboarding branch)
from fastapi.middleware.cors import CORSMiddleware

from .api import main_router
from .services.mongo_client import init_indexes

PRIVACY_PAGE = Path(__file__).resolve().parent / "privacy.html"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Ensure DB indexes (unique email, refresh-token indexes) exist on startup.
    await init_indexes()
    yield


app = FastAPI(title="Monitar", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
<<<<<<< HEAD
    allow_credentials=True,
=======
    allow_credentials=False,
>>>>>>> 241e225 (temp changes to onboarding branch)
    allow_methods=["*"],
    allow_headers=["*"],
)

<<<<<<< HEAD

# Registered before the router so it isn't shadowed by retrieval's GET /{session_id}.
@app.get("/privacy", include_in_schema=False)
async def privacy_policy():
    return FileResponse(PRIVACY_PAGE, media_type="text/html")


=======
>>>>>>> 241e225 (temp changes to onboarding branch)
app.include_router(main_router)
