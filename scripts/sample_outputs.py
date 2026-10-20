"""Print real responses from the Monitar API, no MongoDB required.

Runs the actual FastAPI app in-process against an in-memory fake database, so
every response below is produced by the real route handlers.

    python scripts/sample_outputs.py
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import _fakedb  # noqa: E402  (sets SECRET_KEY before the app imports)

from fastapi.testclient import TestClient  # noqa: E402

from backend.app.main import app  # noqa: E402

_fakedb.install()
client = TestClient(app)  # not used as a context manager: skips Mongo index setup

REDACT = ("access_token", "refresh_token", "content_encrypted")


def clip(o):
    if isinstance(o, dict):
        return {
            k: (v[:24] + "..." if k in REDACT and isinstance(v, str) and len(v) > 24 else clip(v))
            for k, v in o.items()
        }
    if isinstance(o, list):
        return [clip(i) for i in o]
    return o


def show(title, resp):
    print(f"### {title}\n{resp.request.method} {resp.request.url.path} -> {resp.status_code}")
    print(json.dumps(clip(resp.json()), indent=2))
    print()


def unit(vec):
    n = sum(x * x for x in vec) ** 0.5
    return [round(x / n, 4) for x in vec]


up = client.post("/sign-up", json={"name": "Ada", "email": "ada@example.com", "password": "correct-horse-battery"})
show("Sign up", up)
auth = {"Authorization": f"Bearer {up.json()['access_token']}"}

show("Wrong password", client.post("/sign-in", json={"email": "ada@example.com", "password": "nope-nope-nope"}))

# Embeddings are 384-d in production; 4-d here keeps the output readable.
sessions = {
    "Vector databases research": unit([0.9, 0.1, 0.0, 0.1]),
    "Planning a trip to Lisbon": unit([0.0, 0.1, 0.9, 0.2]),
    "Sourdough baking": unit([0.1, 0.9, 0.1, 0.0]),
}
for intent, vec in sessions.items():
    r = client.post("/store", headers=auth, json={
        "intent": intent, "started_at": "2026-10-19T09:30:00Z",
        "content_encrypted": "q83vAAECAwQFBgcICQoL...opaque-base64-ciphertext",
        "content_hash": "n4bQgYhMfWWaL+qgxVrQFaO/TxsrC4Is0V1sFbDwCgg=",
        "embedding": vec, "tab_count": 6, "window_count": 1,
    })
    if intent.startswith("Vector"):
        show("Store a session", r)

show("Semantic search (query about embeddings)",
     client.post("/search", headers=auth, json={"vector": unit([0.8, 0.2, 0.1, 0.1]), "limit": 2}))
show("No token", client.post("/search", json={"vector": [1.0]}))
rt = up.json()["refresh_token"]
show("Rotate refresh token", client.post("/refresh", json={"refresh_token": rt}))
show("Reuse the rotated-out token", client.post("/refresh", json={"refresh_token": rt}))
