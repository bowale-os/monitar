"""Session routes: /store, /search, GET/PUT/DELETE /{session_id}, GET /.

DB-backed tests use the real (throwaway) test database through `client`.
The "database blew up" branches swap the route module's `database` for a stub
that raises, since a healthy Mongo never fails on these calls.
"""
from types import SimpleNamespace

import pytest

from backend.app.api import retrieval

PAYLOAD = {
    "intent": "researching vector databases",
    "content_encrypted": "ciphertext==",
    "content_hash": "abc123",
    "embedding": [1.0, 0.0, 0.0],
    "tab_count": 3,
    "window_count": 1,
}


def _auth(token):
    return {"Authorization": f"Bearer {token}"}


def _store(client, token, **overrides):
    resp = client.post("/store", json={**PAYLOAD, **overrides}, headers=_auth(token))
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


class _Boom:
    """Stands in for database.sessions; every operation raises."""

    def __getattr__(self, name):
        def fail(*args, **kwargs):
            raise RuntimeError("db down")

        return fail


@pytest.fixture
def broken_db(monkeypatch):
    monkeypatch.setattr(retrieval, "database", SimpleNamespace(sessions=_Boom()))


# ------------------------------------------------------------------ #
# POST /store
# ------------------------------------------------------------------ #

def test_store_persists_session_for_the_caller(authed_client, db):
    client, token, _ = authed_client
    session_id = _store(client, token)

    doc = db.sessions.find_one({"_id": session_id})
    assert doc["intent"] == PAYLOAD["intent"]
    assert doc["content_encrypted"] == PAYLOAD["content_encrypted"]
    assert doc["user_id"]


def test_store_requires_auth(client):
    assert client.post("/store", json=PAYLOAD).status_code in (401, 403)


# ------------------------------------------------------------------ #
# PUT /{session_id}
# ------------------------------------------------------------------ #

def test_update_changes_the_session(authed_client, db):
    client, token, _ = authed_client
    session_id = _store(client, token)

    resp = client.put(
        f"/{session_id}", json={**PAYLOAD, "intent": "renamed"}, headers=_auth(token)
    )
    assert resp.status_code == 200
    assert db.sessions.find_one({"_id": session_id})["intent"] == "renamed"


def test_update_unknown_session_returns_404(authed_client):
    client, token, _ = authed_client
    resp = client.put("/nope", json=PAYLOAD, headers=_auth(token))
    assert resp.status_code == 404


def test_update_other_users_session_returns_404(client, signup_user, db):
    owner = signup_user(email="owner@b.com")["access_token"]
    intruder = signup_user(email="intruder@b.com")["access_token"]
    session_id = _store(client, owner)

    resp = client.put(
        f"/{session_id}", json={**PAYLOAD, "intent": "hijacked"}, headers=_auth(intruder)
    )
    assert resp.status_code == 404
    assert db.sessions.find_one({"_id": session_id})["intent"] == PAYLOAD["intent"]


# ------------------------------------------------------------------ #
# GET /{session_id}
# ------------------------------------------------------------------ #

def test_get_session_returns_it(authed_client):
    client, token, _ = authed_client
    session_id = _store(client, token)

    resp = client.get(f"/{session_id}", headers=_auth(token))
    assert resp.status_code == 200
    assert resp.json()["data"]["_id"] == session_id


def test_get_unknown_session_returns_404(authed_client):
    client, token, _ = authed_client
    assert client.get("/nope", headers=_auth(token)).status_code == 404


def test_get_other_users_session_returns_404(client, signup_user):
    owner = signup_user(email="owner@b.com")["access_token"]
    intruder = signup_user(email="intruder@b.com")["access_token"]
    session_id = _store(client, owner)

    assert client.get(f"/{session_id}", headers=_auth(intruder)).status_code == 404


def test_get_session_db_error_returns_400(authed_client, broken_db):
    client, token, _ = authed_client
    assert client.get("/anything", headers=_auth(token)).status_code == 400


# ------------------------------------------------------------------ #
# GET /
# ------------------------------------------------------------------ #

def test_list_returns_only_my_sessions(client, signup_user):
    a = signup_user(email="a@b.com")["access_token"]
    b = signup_user(email="b@b.com")["access_token"]
    mine = _store(client, a)
    _store(client, b)

    resp = client.get("/", headers=_auth(a))
    assert resp.status_code == 200
    assert [s["_id"] for s in resp.json()["data"]] == [mine]


def test_list_empty_for_new_user(authed_client):
    client, token, _ = authed_client
    assert client.get("/", headers=_auth(token)).json()["data"] == []


def test_list_db_error_returns_400(authed_client, broken_db):
    client, token, _ = authed_client
    assert client.get("/", headers=_auth(token)).status_code == 400


# ------------------------------------------------------------------ #
# DELETE /{session_id}
# ------------------------------------------------------------------ #

def test_delete_removes_the_session(authed_client, db):
    client, token, _ = authed_client
    session_id = _store(client, token)

    assert client.delete(f"/{session_id}", headers=_auth(token)).status_code == 200
    assert db.sessions.find_one({"_id": session_id}) is None


def test_delete_unknown_session_returns_404(authed_client):
    client, token, _ = authed_client
    assert client.delete("/nope", headers=_auth(token)).status_code == 404


def test_delete_other_users_session_returns_404(client, signup_user, db):
    owner = signup_user(email="owner@b.com")["access_token"]
    intruder = signup_user(email="intruder@b.com")["access_token"]
    session_id = _store(client, owner)

    assert client.delete(f"/{session_id}", headers=_auth(intruder)).status_code == 404
    assert db.sessions.find_one({"_id": session_id}) is not None


def test_delete_db_error_returns_400(authed_client, broken_db):
    client, token, _ = authed_client
    assert client.delete("/anything", headers=_auth(token)).status_code == 400


# ------------------------------------------------------------------ #
# POST /search
# ------------------------------------------------------------------ #

def _search(client, token, vector, **extra):
    return client.post(
        "/search", json={"vector": vector, **extra}, headers=_auth(token)
    )


def test_search_with_no_sessions_returns_empty(authed_client):
    client, token, _ = authed_client
    assert _search(client, token, [1.0, 0.0, 0.0]).json() == {"data": []}


def test_search_ranks_by_cosine_similarity(authed_client):
    client, token, _ = authed_client
    best = _store(client, token, intent="best", embedding=[1.0, 0.0, 0.0])
    mid = _store(client, token, intent="mid", embedding=[0.6, 0.8, 0.0])
    worst = _store(client, token, intent="worst", embedding=[0.0, 0.0, 1.0])

    data = _search(client, token, [1.0, 0.0, 0.0]).json()["data"]
    assert [r["_id"] for r in data] == [best, mid, worst]
    assert data[0]["score"] == pytest.approx(1.0)
    assert data[1]["score"] == pytest.approx(0.6)
    assert data[2]["score"] == pytest.approx(0.0)


def test_search_normalises_the_query_vector(authed_client):
    client, token, _ = authed_client
    _store(client, token, embedding=[1.0, 0.0, 0.0])

    data = _search(client, token, [5.0, 0.0, 0.0]).json()["data"]
    assert data[0]["score"] == pytest.approx(1.0)


def test_search_zero_vector_scores_zero_without_crashing(authed_client):
    client, token, _ = authed_client
    _store(client, token, embedding=[1.0, 0.0, 0.0])

    data = _search(client, token, [0.0, 0.0, 0.0]).json()["data"]
    assert data[0]["score"] == 0.0


def test_search_respects_limit(authed_client):
    client, token, _ = authed_client
    for i in range(3):
        _store(client, token, intent=f"s{i}")

    assert len(_search(client, token, [1.0, 0.0, 0.0], limit=2).json()["data"]) == 2


def test_search_skips_sessions_without_embeddings(authed_client):
    client, token, _ = authed_client
    _store(client, token, embedding=None)
    with_vec = _store(client, token)

    data = _search(client, token, [1.0, 0.0, 0.0]).json()["data"]
    assert [r["_id"] for r in data] == [with_vec]


def test_search_never_returns_other_users_sessions(client, signup_user):
    a = signup_user(email="a@b.com")["access_token"]
    b = signup_user(email="b@b.com")["access_token"]
    _store(client, b)

    assert _search(client, a, [1.0, 0.0, 0.0]).json() == {"data": []}


def test_search_does_not_leak_embeddings_or_ciphertext(authed_client):
    client, token, _ = authed_client
    _store(client, token)

    row = _search(client, token, [1.0, 0.0, 0.0]).json()["data"][0]
    assert "embedding" not in row
    assert "content_encrypted" not in row
