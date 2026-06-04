from fastapi import APIRouter

from .auth import a_router
from .storage import s_router
from .retrieval import r_router

main_router = APIRouter()

main_router.include_router(a_router)
main_router.include_router(s_router)
main_router.include_router(r_router)