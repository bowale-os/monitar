import os
import unittest
from datetime import datetime, timezone, timedelta

# Set a strong key BEFORE importing security so its startup guard passes and
# the tests don't depend on the real .env. load_dotenv uses override=False, so
# this value wins.
os.environ.setdefault("SECRET_KEY", "test-secret-key-that-is-definitely-long-enough-1234567890")
os.environ.setdefault("ALGORITHM", "HS256")

from jose import jwt
import backend.app.security as security


class TestSecurity(unittest.TestCase):

    def test_hash_password(self):
        """hash_password returns a verifiable hash distinct from the input."""
        password = "R3@5479yc5"
        hashed = security.hash_password(password)
        self.assertNotEqual(password, hashed)
        self.assertTrue(security.verify_password(password, hashed))
        self.assertFalse(security.verify_password("wrong-password", hashed))

    def test_access_token_roundtrip(self):
        """A freshly minted access token decodes back to the same user_id."""
        user_id = "_929302838h9@2$"
        token = security.create_access_token(user_id)
        self.assertEqual(user_id, security.verify_access_token(token))

    def test_expired_access_token_raises(self):
        """An access token whose exp is in the past raises TokenExpireError."""
        past = datetime.now(timezone.utc) - timedelta(minutes=1)
        token = jwt.encode(
            {"sub": "u1", "exp": past, "type": "access"},
            security.SECRET_KEY,
            algorithm=security.ALGORITHM,
        )
        with self.assertRaises(security.TokenExpireError):
            security.verify_access_token(token)

    def test_garbage_access_token_raises(self):
        """A malformed/bad-signature token raises TokenInvalidError."""
        with self.assertRaises(security.TokenInvalidError):
            security.verify_access_token("not.a.real.token")

    def test_refresh_token_hash_is_stable_and_unique(self):
        """hash is deterministic, matches create output, and raw tokens differ."""
        raw1, hash1 = security.create_refresh_token()
        raw2, hash2 = security.create_refresh_token()

        self.assertNotEqual(raw1, raw2)
        self.assertNotEqual(hash1, hash2)
        # Hashing the raw token reproduces the stored hash (enables lookup).
        self.assertEqual(hash1, security.hash_refresh_token(raw1))


if __name__ == "__main__":
    unittest.main()
