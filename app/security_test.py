import unittest
import security

class TestSecurity(unittest.TestCase):

    def test_hash_password(self):
        password = "R3@5479yc5"
        hash = security.hash_password(password)
        converted = security.verify_password(password, hash)
        self.assertTrue(converted)

    def test_create_access_token(self):
        user_id = "_929302838h9@2$"
        token = security.create_access_token(user_id)
        converted = security.verify_access_token(token)
        self.assertEqual(user_id, converted)



if __name__ == "__main__":
    unittest.main()