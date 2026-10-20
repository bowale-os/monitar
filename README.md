# Monitar

[![CI](https://github.com/bowale-os/monitar/actions/workflows/ci.yml/badge.svg)](https://github.com/bowale-os/monitar/actions/workflows/ci.yml)
[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-install-blue)](https://chromewebstore.google.com/detail/monitar/fmglkkadhimdlbpkbabbiigkbnpkdblc)

**A private memory for your research sessions.** Monitar is a Chrome extension that records the tabs you open during a browsing session, then lets you find that session again later by describing it in plain language. Your session contents are encrypted in your browser before they ever leave it, so the server stores data it cannot read.

[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/monitar/fmglkkadhimdlbpkbabbiigkbnpkdblc)

<p align="center"><img src="docs/demo.gif" alt="Monitar demo: start a session and restore past sessions" width="320"></p>

## Why it exists

- **Privacy first.** Session contents (titles, URLs) are encrypted client-side with AES-256-GCM. The key is derived from your password with PBKDF2 and never sent to the server. A database leak exposes ciphertext, not your browsing history.
- **Semantic search, computed locally.** Embeddings are generated inside the extension with `Xenova/all-MiniLM-L6-v2` running on ONNX/WebAssembly. No page text is sent to a third-party AI API.
- **Convenient.** Start a session, browse, and Monitar tracks the tabs for you. Later, search "that article about vector databases" and get the session back, with keyword search over tab titles and URLs as a fallback.

## How it works

```
 Chrome extension (MV3)                          FastAPI backend            MongoDB
 ----------------------                          ---------------            -------
 track tabs in a session
 build text -> embed locally (MiniLM, 384-d)
 encrypt session (AES-GCM, PBKDF2 key)  ---->   /store  (auth required) --> ciphertext + embedding
 search: embed query locally            ---->   /search (cosine similarity
                                                  over embeddings)      <-- ranked session ids
 decrypt matches locally                <----   /{session_id}
```

The server sees only: an encrypted blob, a content hash, an embedding vector, tab/window counts and timestamps. Auth uses bcrypt-hashed passwords, short-lived JWT access tokens and rotating, server-revocable refresh tokens.

| Layer | Stack |
|-------|-------|
| Extension | Manifest V3, vanilla JS, Web Crypto API, Transformers.js (ONNX Runtime Web) |
| Backend | Python 3.12, FastAPI, Pydantic, Authlib, python-jose, bcrypt, NumPy |
| Database | MongoDB (async PyMongo), TTL index for expired refresh tokens |
| Tests / CI | pytest + pytest-asyncio + pytest-cov, Vitest, GitHub Actions |

## Run it locally

### Backend

Prerequisites: Python 3.12 and a MongoDB connection string. Either option works:

- A free [MongoDB Atlas](https://www.mongodb.com/atlas) cluster (no install). Paste its `mongodb+srv://...` URI into `MONGODB_CONNECT`.
- [MongoDB Community Server](https://www.mongodb.com/try/download/community) installed locally, with `MONGODB_CONNECT=mongodb://localhost:27017`.

```bash
pip install -r backend/requirements.txt
cp backend/app/.env.example backend/app/.env     # then set SECRET_KEY (>= 32 chars)
uvicorn backend.app.main:app --reload
```

Interactive API docs are at http://127.0.0.1:8000/docs. Google credentials in `.env` are only needed for Google sign-in.

Try the auth flow:

```bash
curl -X POST http://127.0.0.1:8000/sign-up -H "Content-Type: application/json" \
  -d '{"name":"Ada","email":"ada@example.com","password":"correct-horse-battery"}'
```

The response contains an access token, a refresh token and the per-user key salt used for client-side encryption.

### Extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `frontend/extension` folder.
3. Point `API_BASE` in `frontend/extension/api.js` at `http://127.0.0.1:8000` (it defaults to the production API) and add that origin to `host_permissions` in `manifest.json`.

Or skip all of this and install the published build from the [Chrome Web Store](https://chromewebstore.google.com/detail/monitar/fmglkkadhimdlbpkbabbiigkbnpkdblc).

> `frontend/uploadzip/extension` is the copy packaged for the store and must stay byte-identical to `frontend/extension`. A test enforces this.

## Tests

```bash
# backend: auth routes, JWT/refresh security, dependencies, route registration
pytest

# extension: pure helpers (search, date formatting, escaping) and copy-sync check
cd frontend && npm install && npm test
```

The backend suite enforces 100% line coverage of the app code (`.coveragerc`), and dependencies are pinned in `backend/requirements.txt`.

Backend tests that need MongoDB use a throwaway `monitar_test` database and are skipped if `MONGODB_CONNECT` is unset. Every push and pull request runs both suites in GitHub Actions against a MongoDB service container.

## Repository layout

```
backend/app/
  api/         auth, storage, retrieval routes
  models/      Pydantic models (User, Session, Tab)
  services/    MongoDB and Google OAuth clients
  tests/       pytest suite
frontend/
  extension/   Chrome extension source (popup, background worker, crypto, embeddings)
  tests/       Vitest suite
```

## Privacy

The privacy policy is served by the backend at `/privacy`.

## License

Copyright (c) Daniel Sobowale. All rights reserved. This repository is public for viewing and evaluation only; no license to use, copy, modify or distribute the code is granted.
