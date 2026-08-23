import os

# Must run BEFORE any backend.app.* import: security.py validates SECRET_KEY
# at import time (raises RuntimeError if missing/short), and mongo_client.py
# binds DB_NAME at import time too. load_dotenv() in those modules uses
# override=False, so whatever we set here wins over backend/app/.env.
os.environ.setdefault("SECRET_KEY", "test-secret-key-that-is-definitely-long-enough-1234567890")
os.environ.setdefault("ALGORITHM", "HS256")
os.environ["DB_NAME"] = "monitar_test"

import pytest
from fastapi.testclient import TestClient
from pymongo import MongoClient

from backend.app.main import app

MONGO_URI = os.getenv("MONGODB_CONNECT")
TEST_DB_NAME = "monitar_test"


def _mongo_available() -> bool:
    if not MONGO_URI:
        return False
    try:
        # 1500ms was too tight for mongodb+srv://'s DNS SRV lookup + TLS
        # handshake on a cold connection (observed spurious "unreachable"
        # skips against the real Atlas cluster even though it was up).
        probe = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
        probe.admin.command("ping")
        probe.close()
        return True
    except Exception:
        return False


MONGO_AVAILABLE = _mongo_available()


@pytest.fixture(scope="session")
def requires_mongo():
    """Skip a test if MongoDB isn't reachable.

    Any fixture in this file that talks to the DB (`client`, `db`) depends on
    this, so requesting either one transitively gets the graceful-skip
    behavior for free -- no per-module skip decorators needed. test_security.py
    doesn't use `client`/`db` at all, so it stays fully DB-independent.
    """
    if not MONGO_AVAILABLE:
        pytest.skip("MongoDB not reachable; skipping DB-backed tests")


@pytest.fixture(scope="session")
def client(requires_mongo):
    """One TestClient (one event loop) for the whole session, so the async
    Mongo client binds to a single loop. Entering it runs lifespan -> init_indexes.
    """
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def db(requires_mongo):
    """Raw sync pymongo handle to the throwaway test database, independent of
    the app's own async client -- used for direct seeding/assertions."""
    sync_client = MongoClient(MONGO_URI)
    database = sync_client[TEST_DB_NAME]
    yield database
    sync_client.drop_database(TEST_DB_NAME)
    sync_client.close()


@pytest.fixture(autouse=True)
def clean_db(request):
    """Clean slate between tests for any test that touches `client` or `db`
    (both share the same underlying database, so a test using only `client`
    still needs the previous test's users/sessions cleared out first)."""
    if "db" in request.fixturenames or "client" in request.fixturenames:
        database = request.getfixturevalue("db")
        database.users.delete_many({})
        database.refresh_tokens.delete_many({})
        database.sessions.delete_many({})
    yield


@pytest.fixture
def signup_user(client):
    """Factory fixture: sign up as many distinct users as a test needs."""

    def _signup(email="a@b.com", password="password123", name="A"):
        resp = client.post(
            "/sign-up", json={"name": name, "email": email, "password": password}
        )
        assert resp.status_code == 201, resp.text
        return resp.json()

    return _signup


@pytest.fixture
def authed_client(client, signup_user):
    """Convenience fixture for the common single-user case: (client, access_token, signup body)."""
    body = signup_user()
    return client, body["access_token"], body
