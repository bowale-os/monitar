first thing was take care of suthentication, sign up and sign in

- next would be storing the data from the frontend (extension) in the database...

- i made a dependency file with the `get_current_user_id` function, and after, a storage route




should sessions have names (optional)?






added today (6/24/2026)



im trying to implement secure storage for the users. 
this is suppossed to be a plan to follow, ill adjust it to the project's actual stack

-------------------------------------------
This is a full implementation plan for your privacy-preserving browser session app with encrypted storage and vector-based semantic search.

I’ll break it into **phases**, **tasks**, and **code outlines** for:
- frontend (browser extension + JS)
- backend (Python/FastAPI + Pydantic)
- encryption (client-side AES-GCM)
- vector search (embedding + vector DB)

***

## Overall architecture

- **Frontend:** Chrome/Firefox extension (React/TS or vanilla JS)
  - Collects tab data
  - Builds `SessionContent`
  - Encrypts it with AES-GCM
  - Generates embeddings
  - Sends encrypted payload + metadata + vector to backend
- **Backend:** Python/FastAPI
  - Pydantic models (`User`, `Session`, `SessionContent`, `Tab`)
  - REST API for save/load/search
  - Vector DB for `embedding` (PostgreSQL + pgvector, or another vector DB)
  - Stores `content_encrypted` as bytes / base64
- **Key management:**
  - User password → PBKDF2 → AES-256-GCM key
  - Salt stored in browser (localStorage/IndexedDB)
  - Key never stored on backend

***

## Phase 0: Foundations

### Tasks
1. Define project structure:
   - `frontend/` (extension)
   - `backend/` (FastAPI + Pydantic)
   - `shared/` (optional: shared types if needed)
2. Set up:
   - Backend: Python 3.11+, FastAPI, Pydantic v2, PostgreSQL + pgvector
   - Frontend: Node + TypeScript, Vite or Webpack, browser extension manifest v3

***

## Phase 1: Data models (Pydantic backend)

### Files
- `backend/models/tab.py`
- `backend/models/session_content.py`
- `backend/models/session.py`
- `backend/models/user.py`

### Code outline

```python
# backend/models/tab.py
from pydantic import BaseModel
from datetime import datetime
from typing import Optional

class Tab(BaseModel):
    url: str
    title: str
    opened_at: datetime
    time_spent: int = 0
    time_since_prev: int = 0
    is_last_opened: bool = False
    fetched: bool = False
    page_snippet: Optional[str] = None
```

```python
# backend/models/session_content.py
from pydantic import BaseModel
from datetime import datetime
from typing import List, Optional
from .tab import Tab

class SessionContent(BaseModel):
    intent: str
    started_at: datetime
    stopped_at: Optional[datetime] = None
    tabs: List[Tab]
```

```python
# backend/models/session.py
from pydantic import BaseModel, Field
from datetime import datetime, timezone
from typing import Optional, List
from uuid import UUID, uuid4

class Session(BaseModel):
    id: UUID = Field(default_factory=uuid4)
    user_id: UUID
    name: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    is_active: bool = True
    content_encrypted: bytes
    content_hash: Optional[str] = None
    embedding: Optional[List[float]] = None
    search_text: Optional[str] = None
```

```python
# backend/models/user.py
from pydantic import BaseModel, EmailStr
from datetime import datetime
from typing import Optional
from uuid import UUID, uuid4

class User(BaseModel):
    id: UUID = Field(default_factory=uuid4)
    email: EmailStr
    name: str
    picture: Optional[str] = None
    created_at: datetime
```

***

## Phase 2: Encryption (frontend AES-GCM)

### Files
- `frontend/crypto/key.ts`
- `frontend/crypto/encrypt.ts`
- `frontend/crypto/decrypt.ts`

### Key derivation

```ts
// frontend/crypto/key.ts
export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt,
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

export async function generateSalt(): Promise<Uint8Array> {
  return crypto.getRandomValues(new Uint8Array(16));
}
```

### Encryption

```ts
// frontend/crypto/encrypt.ts
import { deriveKey } from "./key";

export async function encryptString(
  dataStr: string,
  key: CryptoKey
): Promise<string> {
  const encoded = new TextEncoder().encode(dataStr);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoded
  );

  const result = new Uint8Array(iv.byteLength + encrypted.byteLength);
  result.set(iv);
  result.set(new Uint8Array(encrypted), iv.byteLength);

  return btoa(String.fromCharCode(...result));
}
```

### Decryption

```ts
// frontend/crypto/decrypt.ts
export async function decryptString(base64: string, key: CryptoKey): Promise<string> {
  const data = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const iv = data.slice(0, 12);
  const encrypted = data.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    encrypted
  );

  return new TextDecoder().decode(decrypted);
}
```

***

## Phase 3: Session data collection (extension)

### Files
- `frontend/extension/sessionCollector.ts`
- `frontend/extension/sessionService.ts`

### Collector

```ts
// frontend/extension/sessionCollector.ts
import { Tab, SessionContent } from "../models"; // shared types or JS equivalent

export async function collectTabs(windowId: number): Promise<Tab[]> {
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.map(t => ({
    url: t.url!,
    title: t.title!,
    opened_at: new Date(),
    time_spent: 0,
    time_since_prev: 0,
    is_last_opened: t.active,
    fetched: false,
    page_snippet: null
  }));
}

export async function buildSessionContent(
  intent: string,
  windowId: number
): Promise<SessionContent> {
  const tabs = await collectTabs(windowId);
  return {
    intent,
    started_at: new Date(),
    stopped_at: null,
    tabs
  };
}
```

### Service

```ts
// frontend/extension/sessionService.ts
import { encryptString } from "../crypto/encrypt";
import { deriveKey, generateSalt } from "../crypto/key";
import { buildSessionContent } from "./sessionCollector";

export interface SessionRecord {
  id: string;
  userId: string;
  name?: string;
  createdAt: string;
  updatedAt: string;
  isActive: boolean;
  contentEncrypted: string;
  contentHash?: string;
  embedding?: number[];
  searchText?: string;
}

export async function saveSession(
  intent: string,
  windowId: number,
  userId: string,
  name?: string,
  password: string,
  salt: Uint8Array
): Promise<SessionRecord> {
  const sessionContent = await buildSessionContent(intent, windowId);
  const json = JSON.stringify(sessionContent);

  const key = await deriveKey(password, salt);
  const contentEncrypted = await encryptString(json, key);

  // Generate embedding here (see Phase 4)
  const embedding = await generateEmbeddingFromSession(sessionContent);

  return {
    id: crypto.randomUUID(),
    userId,
    name,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isActive: true,
    contentEncrypted,
    embedding: embedding,
    searchText: intent
  };
}
```

***

## Phase 4: Embedding generation (vector search)

### Options
- Run embedding model in frontend (e.g. via TensorFlow.js or ONNX)
- Or call a backend embedding API (simpler at first)

For MVP, use a simple backend embedding API:

```ts
// frontend/extension/embeddingService.ts
export async function generateEmbeddingFromSession(
  sessionContent: { intent: string; tabs: Array<{ title: string }> }
): Promise<number[]> {
  const text = sessionContent.intent + " " +
    sessionContent.tabs.map(t => t.title).join(" ");

  const res = await fetch(`${API_BASE}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });

  const data = await res.json();
  return data.embedding; // number[]
}
```

Backend endpoint:

```python
# backend/api/embed.py
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

class EmbedRequest(BaseModel):
    text: str

@router.post("/embed")
def embed_text(req: EmbedRequest):
    # Use your embedding model here
    # e.g. sentence-transformers, or an external API
    embedding = your_embedding_model.encode(req.text)
    return {"embedding": list(embedding)}
```

***

## Phase 5: Backend API (FastAPI)

### Files
- `backend/api/auth.py`
- `backend/api/session.py`
- `backend/api/search.py`

### Auth (simplified)

```python
# backend/api/auth.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

class LoginRequest(BaseModel):
    email: str
    password: str

@router.post("/login")
def login(req: LoginRequest):
    # authenticate user, return userId
    # store salt in response or manage separately
    user = get_user_by_email(req.email)
    if not user or not valid_password(user, req.password):
        raise HTTPException(401, "Invalid credentials")
    return {"userId": user.id, "salt": user.salt}  # salt stored in DB
```

### Save session

```python
# backend/api/session.py
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from uuid import UUID
from models.session import Session
from db.session_db import create_session, get_session

router = APIRouter()

class SaveSessionRequest(BaseModel):
    userId: UUID
    name: str | None = None
    contentEncrypted: str  # base64
    contentHash: str | None = None
    embedding: list[float] | None = None
    searchText: str | None = None

@router.post("/sessions")
def save_session(req: SaveSessionRequest):
    session = Session(
        user_id=req.userId,
        name=req.name,
        content_encrypted=req.contentEncrypted.encode(),
        content_hash=req.contentHash,
        embedding=req.embedding,
        search_text=req.searchText
    )
    create_session(session)
    return {"id": session.id}
```

### Load session

```python
@router.get("/sessions/{session_id}")
def get_session(session_id: UUID):
    session = get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    return {
        "id": session.id,
        "userId": session.user_id,
        "name": session.name,
        "contentEncrypted": session.content_encrypted.decode(),
        "embedding": session.embedding,
        "searchText": session.search_text
    }
```

### Search

```python
# backend/api/search.py
from fastapi import APIRouter
from pydantic import BaseModel
from uuid import UUID
from db.vector_db import vector_search

router = APIRouter()

class SearchRequest(BaseModel):
    query: str
    user_id: UUID
    limit: int = 10

class SearchResultItem(BaseModel):
    id: UUID
    name: str | None = None
    score: float

@router.post("/search")
def search_sessions(req: SearchRequest):
    # Embed query
    query_embedding = your_embedding_model.encode(req.query)

    ids = vector_search(
        user_id=req.user_id,
        embedding=query_embedding,
        limit=req.limit
    )

    results: List[SearchResultItem] = []
    for session_id, score in ids:
        session = get_session(session_id)
        results.append(SearchResultItem(id=session.id, name=session.name, score=score))

    return {"results": results}
```

***

## Phase 6: Storage and vector DB

### Database
- Use PostgreSQL
- Add `pgvector` extension for vector search

Table for sessions:

```sql
CREATE TABLE sessions (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL,
    name TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    content_encrypted BYTEA NOT NULL,
    content_hash TEXT,
    embedding vector(768),  -- adjust size to your model
    search_text TEXT
);

CREATE INDEX sessions_embedding_idx ON sessions
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
```

Use `pgvector` in Python via `psycopg` or `asyncpg`.

***

## Phase 7: Frontend restore logic

```ts
// frontend/extension/sessionRestore.ts
import { decryptString } from "../crypto/decrypt";

export async function restoreSession(
  sessionRecord: SessionRecord,
  password: string,
  salt: Uint8Array
): Promise<{ intent: string; tabs: Tab[] }> {
  const key = await deriveKey(password, salt);
  const decryptedJson = await decryptString(sessionRecord.contentEncrypted, key);
  const sessionContent = JSON.parse(decryptedJson) as { intent: string; tabs: Tab[] };

  // Open tabs
  for (const tab of sessionContent.tabs) {
    await chrome.tabs.create({ url: tab.url });
  }

  return sessionContent;
}
```

***

## Phase 8: Testing and security checks

- Test encryption/decryption roundtrip (JS encrypt → JS decrypt).
- Test JS encrypt → Python decrypt (optional).
- Verify backend never sees raw URLs/titles.
- Ensure key and salt are stored only in browser.
- Add auth middleware for all endpoints.

***

This is your full implementation plan. If you want, I can next:
- Generate a minimal working repo structure with all files,
- Or start with a single-phase MVP (e.g. encryption + save/load only, no vector search) to test first.