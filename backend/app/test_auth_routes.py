import os
import unittest

# Configure env BEFORE importing the app: strong key (passes the startup guard)
# and a throwaway database so we never touch real data.
os.environ.setdefault("SECRET_KEY", "test-secret-key-that-is-definitely-long-enough-1234567890")
os.environ.setdefault("ALGORITHM", "HS256")
os.environ["DB_NAME"] = "monitar_test"

from fastapi.testclient import TestClient
from pymongo import MongoClient

from backend.app.main import app

MONGO_URI = os.getenv("MONGODB_CONNECT")


def mongo_available():
    if not MONGO_URI:
        return False
    try:
        client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=1500)
        client.admin.command("ping")
        client.close()
        return True
    except Exception:
        return False


@unittest.skipUnless(mongo_available(), "MongoDB not reachable; skipping route tests")
class TestAuthRoutes(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        # One TestClient (one event loop) for the whole class so the async Mongo
        # client binds to a single loop. Entering it runs lifespan -> init_indexes.
        cls.sync = MongoClient(MONGO_URI)
        cls.db = cls.sync["monitar_test"]
        cls.client_cm = TestClient(app)
        cls.client = cls.client_cm.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client_cm.__exit__(None, None, None)
        cls.sync.drop_database("monitar_test")
        cls.sync.close()

    def setUp(self):
        # Clean slate between tests (the unique email index persists).
        self.db.users.delete_many({})
        self.db.refresh_tokens.delete_many({})

    def _signup(self, email="a@b.com", password="password123", name="A"):
        return self.client.post(
            "/sign-up", json={"name": name, "email": email, "password": password}
        )

    def test_signup_duplicate_email_returns_400(self):
        self.assertEqual(self._signup().status_code, 201)
        self.assertEqual(self._signup().status_code, 400)

    def test_signin_is_enumeration_safe(self):
        self._signup(email="real@b.com", password="password123")
        unknown = self.client.post(
            "/sign-in", json={"email": "nope@b.com", "password": "password123"}
        )
        wrong_pw = self.client.post(
            "/sign-in", json={"email": "real@b.com", "password": "wrongpass1"}
        )
        self.assertEqual(unknown.status_code, 401)
        self.assertEqual(wrong_pw.status_code, 401)
        # Identical body so neither response reveals whether the email exists.
        self.assertEqual(unknown.json()["detail"], wrong_pw.json()["detail"])

    def test_refresh_rotates_and_old_token_is_rejected(self):
        rt = self._signup().json()["refresh_token"]

        rotated = self.client.post("/refresh", json={"refresh_token": rt})
        self.assertEqual(rotated.status_code, 200)
        self.assertNotEqual(rt, rotated.json()["refresh_token"])

        # Reusing the now-rotated token must fail.
        self.assertEqual(
            self.client.post("/refresh", json={"refresh_token": rt}).status_code, 401
        )

    def test_logout_revokes_refresh_token(self):
        rt = self._signup().json()["refresh_token"]
        self.client.post("/logout", json={"refresh_token": rt})
        self.assertEqual(
            self.client.post("/refresh", json={"refresh_token": rt}).status_code, 401
        )

    def test_short_password_rejected(self):
        r = self.client.post(
            "/sign-up", json={"name": "A", "email": "x@b.com", "password": "short"}
        )
        self.assertEqual(r.status_code, 422)


if __name__ == "__main__":
    unittest.main()
