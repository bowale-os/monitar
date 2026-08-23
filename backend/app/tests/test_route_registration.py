from backend.app.main import app


def test_privacy_route_registered_before_dynamic_session_route():
    """GET /privacy must resolve to the dedicated handler, not retrieval's
    GET /{session_id} -- the two routers are flat (no prefixes), so
    registration order is what prevents the dynamic segment from shadowing
    the static one. This is the regression test for the collision called out
    in backend/app/main.py's own comment."""
    paths_in_order = [getattr(r, "path", None) for r in app.router.routes]
    privacy_index = paths_in_order.index("/privacy")
    dynamic_session_indices = [
        i for i, p in enumerate(paths_in_order) if p == "/{session_id}"
    ]
    assert dynamic_session_indices, "expected at least one /{session_id} route"
    assert all(privacy_index < i for i in dynamic_session_indices)


def test_privacy_route_returns_html_not_401(client):
    resp = client.get("/privacy")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")


def test_privacy_route_requires_no_auth(client):
    # No Authorization header at all -- must not 401/403 like the protected
    # dynamic-segment routes it sits next to in the route table.
    resp = client.get("/privacy", headers={})
    assert resp.status_code == 200


def test_privacy_excluded_from_openapi_schema():
    schema = app.openapi()
    assert "/privacy" not in schema["paths"]


def test_no_unexpected_route_method_path_collisions():
    """Sanity-check the full flat route table (auth/storage/retrieval routers
    all mount with no path prefix) for accidental overlap. Different HTTP
    methods on the same path template (e.g. GET/PUT/DELETE /{session_id})
    are normal REST design, not collisions -- only an identical
    (method, path) pair registered twice would be a real bug."""
    from collections import Counter

    method_path_pairs = []
    for r in app.router.routes:
        path = getattr(r, "path", None)
        methods = getattr(r, "methods", None) or set()
        for method in methods:
            method_path_pairs.append((method, path))

    counts = Counter(method_path_pairs)
    duplicates = {pair: n for pair, n in counts.items() if n > 1}
    assert duplicates == {}, f"unexpected duplicate (method, path) registrations: {duplicates}"
