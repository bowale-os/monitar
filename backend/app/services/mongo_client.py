import pymongo
from pymongo import AsyncMongoClient
from dotenv import load_dotenv
from pathlib import Path
import os

# .env lives at backend/app/.env — two levels up from this services/ file.
load_dotenv(Path(__file__).resolve().parents[1] / ".env")

mongo_connect = os.getenv("MONGODB_CONNECT")

mongo_client = AsyncMongoClient(mongo_connect)

# DB name is configurable so tests can run against a throwaway database.
database = mongo_client[os.getenv("DB_NAME", "monitar")]


async def init_indexes():
    """
    Ensure the indexes the auth flow relies on. Idempotent — safe to call on
    every startup.
    """
    # Enforce unique emails at the DB level (closes the concurrent-signup race).
    await database.users.create_index("email", unique=True)

    # Refresh tokens: fast unique lookup by hash, lookups by user, and a TTL
    # index so expired tokens are purged automatically.
    await database.refresh_tokens.create_index("token_hash", unique=True)
    await database.refresh_tokens.create_index("user_id")
    await database.refresh_tokens.create_index("expires_at", expireAfterSeconds=0)
