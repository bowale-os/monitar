import threading
from datetime import datetime, timedelta, timezone

from bson import ObjectId

import backend.app.security as security


def _signup(client, email="a@b.com", password="password123", name="A"):
    return client.post(
        "/sign-up", json={"name": name, "email": email, "password": password}
    )


def _valid_signup_body(**overrides):
    body = {"name": "A", "email": "a@b.com", "password": "password123"}
    body.update(overrides)
    return body


# ------------------------------------------------------------------ #
# POST /sign-up
# ------------------------------------------------------------------ #

def test_signup_happy_path(client, db):
    resp = _signup(client, email="happy@b.com", password="password123", name="Happy")
    assert resp.status_code == 201
    body = resp.json()
    assert set(body.keys()) == {"message", "access_token", "refresh_token", "enc_salt"}

    doc = db.users.find_one({"email": "happy@b.com"})
    assert doc is not None
    assert doc["name"] == "Happy"
    assert doc["password"] != "password123"  # stored hashed, not plaintext
    assert security.verify_password("password123", doc["password"])
    assert "created_at" in doc
    assert doc["enc_salt"] == body["enc_salt"]


def test_signup_duplicate_email_returns_400(client):
    assert _signup(client).status_code == 201
    assert _signup(client).status_code == 400


def test_signup_duplicate_email_case_sensitivity(client):
    # No collation on the unique index, so Mongo treats these as distinct
    # keys -- both signups succeed. Documents current behavior, not a
    # requirement; flag to the user if case-insensitive emails are wanted.
    first = client.post(
        "/sign-up",
        json={"name": "A", "email": "CaseTest@Example.com", "password": "password123"},
    )
    second = client.post(
        "/sign-up",
        json={"name": "B", "email": "casetest@example.com", "password": "password123"},
    )
    assert first.status_code == 201
    assert second.status_code == 201


def test_signup_concurrent_duplicate_only_one_succeeds(client):
    results = []

    def _do():
        results.append(_signup(client, email="race@b.com").status_code)

    threads = [threading.Thread(target=_do) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert results.count(201) == 1
    assert all(code in (201, 400) for code in results)


def test_signup_missing_required_fields(client):
    for field in ("name", "email", "password"):
        body = _valid_signup_body()
        del body[field]
        resp = client.post("/sign-up", json=body)
        assert resp.status_code == 422, f"expected 422 with '{field}' missing"


def test_signup_invalid_email_format_rejected(client):
    resp = client.post("/sign-up", json=_valid_signup_body(email="not-an-email"))
    assert resp.status_code == 422


def test_signup_password_too_short_rejected(client):
    resp = client.post("/sign-up", json=_valid_signup_body(password="short"))
    assert resp.status_code == 422


def test_signup_password_too_long_rejected(client):
    resp = client.post("/sign-up", json=_valid_signup_body(password="x" * 73))
    assert resp.status_code == 422


def test_signup_password_exactly_72_bytes_accepted(client):
    resp = client.post("/sign-up", json=_valid_signup_body(email="p72@b.com", password="x" * 72))
    assert resp.status_code == 201


def test_signup_empty_name_currently_accepted(client):
    # `name` has no min_length constraint today -- this pins the current
    # permissive behavior rather than asserting it's correct.
    resp = client.post("/sign-up", json=_valid_signup_body(email="empty-name@b.com", name=""))
    assert resp.status_code == 201


def test_signup_very_large_name_currently_accepted(client):
    resp = client.post(
        "/sign-up", json=_valid_signup_body(email="large-name@b.com", name="N" * 10_000)
    )
    assert resp.status_code == 201


def test_signup_unicode_name_and_password_roundtrip(client, db):
    resp = client.post(
        "/sign-up",
        json=_valid_signup_body(email="unicode@b.com", name="蒙面侠 🦸", password="pässwörd🔒"),
    )
    assert resp.status_code == 201
    doc = db.users.find_one({"email": "unicode@b.com"})
    assert doc["name"] == "蒙面侠 🦸"
    assert security.verify_password("pässwörd🔒", doc["password"])


def test_signup_null_and_wrong_type_fields_rejected(client):
    assert client.post("/sign-up", json=_valid_signup_body(email=None)).status_code == 422
    assert client.post("/sign-up", json=_valid_signup_body(password=12345678)).status_code == 422


def test_signup_response_never_leaks_password_hash(client):
    resp = _signup(client, email="nohash@b.com")
    body = resp.json()
    assert "password" not in body
    assert "password" not in body.get("user_data", {})


def test_signup_enc_salt_differs_per_user(client):
    a = _signup(client, email="salt-a@b.com").json()["enc_salt"]
    b = _signup(client, email="salt-b@b.com").json()["enc_salt"]
    assert a != b


# ------------------------------------------------------------------ #
# POST /sign-in
# ------------------------------------------------------------------ #

def test_signin_happy_path(client):
    _signup(client, email="signin@b.com", password="password123", name="Signer")
    resp = client.post("/sign-in", json={"email": "signin@b.com", "password": "password123"})
    assert resp.status_code == 202
    body = resp.json()
    assert body["user_data"]["email"] == "signin@b.com"
    assert body["user_data"]["name"] == "Signer"
    assert "id" in body["user_data"]
    assert body["access_token"]
    assert body["refresh_token"]
    assert body["enc_salt"]


def test_signin_is_enumeration_safe(client):
    _signup(client, email="real@b.com", password="password123")
    unknown = client.post(
        "/sign-in", json={"email": "nope@b.com", "password": "password123"}
    )
    wrong_pw = client.post(
        "/sign-in", json={"email": "real@b.com", "password": "wrongpass1"}
    )
    assert unknown.status_code == 401
    assert wrong_pw.status_code == 401
    # Same status, same detail, and same response shape -- neither response
    # should leak whether the email exists via any observable difference.
    assert unknown.json()["detail"] == wrong_pw.json()["detail"]
    assert set(unknown.json().keys()) == set(wrong_pw.json().keys())


def test_signin_unknown_email_returns_401(client):
    resp = client.post("/sign-in", json={"email": "ghost@b.com", "password": "password123"})
    assert resp.status_code == 401


def test_signin_wrong_password_returns_401(client):
    _signup(client, email="pw@b.com", password="password123")
    resp = client.post("/sign-in", json={"email": "pw@b.com", "password": "wrongpass1"})
    assert resp.status_code == 401


def test_signin_malformed_email_rejected(client):
    resp = client.post("/sign-in", json={"email": "not-an-email", "password": "password123"})
    assert resp.status_code == 422


def test_signin_empty_password_does_not_crash(client):
    _signup(client, email="emptypw@b.com", password="password123")
    resp = client.post("/sign-in", json={"email": "emptypw@b.com", "password": ""})
    assert resp.status_code == 401


def test_signin_email_case_mismatch_returns_401(client):
    # sign-in does an exact-match lookup, so a case difference from the
    # stored email currently fails to authenticate -- pins the asymmetry
    # alongside signup's case-sensitive duplicate behavior above.
    client.post(
        "/sign-up",
        json={"name": "A", "email": "CaseSignin@Example.com", "password": "password123"},
    )
    resp = client.post(
        "/sign-in", json={"email": "casesignin@example.com", "password": "password123"}
    )
    assert resp.status_code == 401


def test_signin_immediately_after_signup(client):
    signup_tokens = _signup(client, email="chain@b.com", password="password123").json()
    signin_tokens = client.post(
        "/sign-in", json={"email": "chain@b.com", "password": "password123"}
    ).json()
    assert signin_tokens["access_token"] != signup_tokens["access_token"]
    assert signin_tokens["refresh_token"] != signup_tokens["refresh_token"]


# ------------------------------------------------------------------ #
# POST /refresh
# ------------------------------------------------------------------ #

def test_refresh_rotates_and_old_token_is_rejected(client):
    rt = _signup(client).json()["refresh_token"]

    rotated = client.post("/refresh", json={"refresh_token": rt})
    assert rotated.status_code == 200
    assert rt != rotated.json()["refresh_token"]

    # Reusing the now-rotated token must fail.
    assert client.post("/refresh", json={"refresh_token": rt}).status_code == 401


def test_refresh_invalid_never_issued_token_returns_401(client):
    resp = client.post("/refresh", json={"refresh_token": "never-issued-token"})
    assert resp.status_code == 401


def test_refresh_empty_string_token_returns_401(client):
    resp = client.post("/refresh", json={"refresh_token": ""})
    assert resp.status_code == 401


def test_refresh_missing_field_returns_422(client):
    resp = client.post("/refresh", json={})
    assert resp.status_code == 422


def test_refresh_expired_token_hits_defensive_check(client, db):
    # The TTL index only sweeps periodically, so a token whose expires_at is
    # already in the past but hasn't been purged yet must still be rejected
    # by the route's own defensive datetime comparison. Currently untested.
    rt = _signup(client, email="expired@b.com").json()["refresh_token"]
    token_hash = security.hash_refresh_token(rt)
    past = datetime.now(timezone.utc) - timedelta(days=1)
    result = db.refresh_tokens.update_one(
        {"token_hash": token_hash}, {"$set": {"expires_at": past}}
    )
    assert result.matched_count == 1

    resp = client.post("/refresh", json={"refresh_token": rt})
    assert resp.status_code == 401


def test_refresh_orphaned_token_returns_401(client, db):
    # The token record is valid, but its owning user has since been deleted.
    signup_body = _signup(client, email="orphan@b.com").json()
    rt = signup_body["refresh_token"]
    user_id = security.verify_access_token(signup_body["access_token"])

    delete_result = db.users.delete_one({"_id": ObjectId(user_id)})
    assert delete_result.deleted_count == 1

    resp = client.post("/refresh", json={"refresh_token": rt})
    assert resp.status_code == 401


def test_refresh_concurrent_reuse_only_one_succeeds(client):
    rt = _signup(client, email="race-refresh@b.com").json()["refresh_token"]
    results = []

    def _do():
        results.append(client.post("/refresh", json={"refresh_token": rt}).status_code)

    threads = [threading.Thread(target=_do) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert results.count(200) == 1
    assert all(code in (200, 401) for code in results)


def test_refresh_returns_matching_enc_salt(client):
    signup_body = _signup(client, email="salt-refresh@b.com").json()
    refreshed = client.post(
        "/refresh", json={"refresh_token": signup_body["refresh_token"]}
    ).json()
    assert refreshed["enc_salt"] == signup_body["enc_salt"]


# ------------------------------------------------------------------ #
# POST /logout
# ------------------------------------------------------------------ #

def test_logout_revokes_refresh_token(client):
    rt = _signup(client).json()["refresh_token"]
    client.post("/logout", json={"refresh_token": rt})
    assert client.post("/refresh", json={"refresh_token": rt}).status_code == 401


def test_logout_unknown_token_is_a_noop_200(client):
    resp = client.post("/logout", json={"refresh_token": "never-issued-token"})
    assert resp.status_code == 200


def test_logout_empty_string_token_is_a_noop_200(client):
    resp = client.post("/logout", json={"refresh_token": ""})
    assert resp.status_code == 200


def test_logout_twice_is_idempotent(client):
    rt = _signup(client, email="double-logout@b.com").json()["refresh_token"]
    first = client.post("/logout", json={"refresh_token": rt})
    second = client.post("/logout", json={"refresh_token": rt})
    assert first.status_code == 200
    assert second.status_code == 200


def test_logout_missing_field_returns_422(client):
    resp = client.post("/logout", json={})
    assert resp.status_code == 422


# ------------------------------------------------------------------ #
# Cross-cutting
# ------------------------------------------------------------------ #

def test_malformed_json_body_returns_422(client):
    for path in ("/sign-up", "/sign-in", "/refresh", "/logout"):
        resp = client.post(
            path, content="not valid json", headers={"content-type": "application/json"}
        )
        assert resp.status_code == 422, f"expected 422 for malformed JSON on {path}"


def test_wrong_http_method_returns_405(client):
    # PATCH, not GET: the routers are flat with no path prefixes, so a GET to
    # e.g. /sign-up actually matches retrieval's catch-all GET /{session_id}
    # (session_id="sign-up") instead of falling through to a real 405. PATCH
    # has no handler registered anywhere in the app, so it genuinely
    # exercises Starlette's "path matches, method doesn't" 405 aggregation.
    for path in ("/sign-up", "/sign-in", "/refresh", "/logout"):
        resp = client.patch(path)
        assert resp.status_code == 405, f"expected 405 for PATCH {path}"
