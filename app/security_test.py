import unittest
import security

class TestSecurity(unittest.TestCase):

    def test_hash_password(self):
        """
        test that the hash_password function returns a string that is not the same as the original password"""
        password = "R3@5479yc5"
        hash = security.hash_password(password)
        converted = security.verify_password(password, hash)
        self.assertTrue(converted)


    #added a token expiration time, test doesnt really matter
    def test_create_access_token(self):
        """test that the create_access_token function returns a string that is not the same as the original user_id"""
        user_id = "_929302838h9@2$"
        token = security.create_access_token(user_id)
        converted = security.verify_access_token(token)
        self.assertEqual(user_id, converted)



if __name__ == "__main__":
    unittest.main()