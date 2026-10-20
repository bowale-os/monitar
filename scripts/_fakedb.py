"""Tiny in-memory stand-in for the async PyMongo collections the app uses.

Only the calls the routes make are implemented. It lets the sample-output and
benchmark scripts exercise the real FastAPI handlers without a MongoDB server.
"""
import os
import itertools

from bson import ObjectId

# Must be set before any backend.app import (security.py validates it).
os.environ.setdefault("SECRET_KEY", "scripts-secret-key-that-is-long-enough-0123456789")


def _matches(doc, query):
    for k, v in query.items():
        if isinstance(v, dict):
            if "$ne" in v and doc.get(k) == v["$ne"]:
                return False
            if v.get("$exists") is True and k not in doc:
                return False
        elif doc.get(k) != v:
            return False
    return True


class _Cursor:
    def __init__(self, docs):
        self._docs = docs

    async def to_list(self, length=None):
        return self._docs


class _Result:
    def __init__(self, inserted_id=None, matched=0, deleted=0):
        self.inserted_id = inserted_id
        self.matched_count = matched
        self.deleted_count = deleted


class FakeCollection:
    def __init__(self):
        self.docs = []
        self._ids = itertools.count(1)

    async def insert_one(self, doc):
        if "_id" not in doc:
            doc["_id"] = ObjectId()
        self.docs.append(doc)
        return _Result(inserted_id=doc["_id"])

    async def find_one(self, query):
        return next((d for d in self.docs if _matches(d, query)), None)

    def find(self, query, projection=None):
        found = [d for d in self.docs if _matches(d, query)]
        if projection:
            keep = {k for k, v in projection.items() if v}
            found = [{k: d[k] for k in keep if k in d} for d in found]
        return _Cursor(found)

    async def find_one_and_delete(self, query):
        doc = await self.find_one(query)
        if doc:
            self.docs.remove(doc)
        return doc

    async def delete_one(self, query):
        doc = await self.find_one(query)
        if doc:
            self.docs.remove(doc)
        return _Result(deleted=1 if doc else 0)

    async def update_one(self, query, update):
        doc = await self.find_one(query)
        if doc:
            doc.update(update["$set"])
        return _Result(matched=1 if doc else 0)


class FakeDatabase:
    def __init__(self):
        self.users = FakeCollection()
        self.sessions = FakeCollection()
        self.refresh_tokens = FakeCollection()


def install(db=None):
    """Swap the module-level `database` in every route module for a fake."""
    from backend.app.api import auth, retrieval, storage

    db = db or FakeDatabase()
    for module in (auth, retrieval, storage):
        module.database = db
    return db
