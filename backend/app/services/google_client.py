from authlib.integrations.starlette_client import OAuth
from dotenv import load_dotenv
from pathlib import Path
import os

# .env lives at backend/app/.env — two levels up from this services/ file.
load_dotenv(Path(__file__).resolve().parents[1] / ".env")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
SECRET_KEY = os.getenv("SECRET_KEY")

oauth = OAuth()

oauth.register(
    name="google auth",
    client_id=GOOGLE_CLIENT_ID,
    client_secret=GOOGLE_CLIENT_SECRET,
    authorize_url="https://accounts.google.com/o/oauth2/auth",
    authorize_params=None,
    access_token_url="https://accounts.google.com/o/oauth2/token",
    access_token_params=None,
    refresh_token_url=None,
    authorize_state=SECRET_KEY,
    redirect_uri="",
    jwks_uri="https://www.googleapis.com/oauth2/v3/certs",
    client_kwargs={"scope": "openid profile email"},
)

