# Copilot instructions for YaoAINote

Purpose: help future Copilot sessions quickly understand how to run, inspect, and change this repository.

## Quick commands

- Install deps (root, uses npm workspaces):
  - npm ci
- Dev (two terminals):
  - npm run dev:server # runs server (node --watch src/index.js)
  - npm run dev:client # runs client (vite)
- Build / prod:
  - cd client && npm run build
  - cd client && npm run preview
  - cd server && npm start

Notes: there are no test or lint scripts in package.json files; add them in server/client if needed.

## High-level architecture (big picture)

- Monorepo (npm workspaces): root with `server/` and `client/` packages.
- Backend (server): Node.js + Express exposing two main APIs:
  - /api/documents — accept file uploads (multer.memoryStorage), parse to text, chunk, embed (Voyage), upsert vectors to Pinecone, store metadata in a small SQLite DB (server/data/).
  - /api/chat — embed query, query Pinecone for top-K chunks, stream an answer from Anthropic Claude to the client over SSE with source citation events.
- Frontend (client): Vite + React. Components: Chat, Uploader, DocumentList, ApiKeyGate. Client communicates via /api endpoints and uses SSE parsing in client/src/api.js for streaming.
- LLM + embeddings + vector DB:
  - Claude (Anthropic SDK) for answers (system prompt in server/src/lib/claude.js)
  - Voyage AI embeddings (voyage-3-large, 1024 dims) in server/src/lib/embed.js
  - Pinecone for vector storage; index name from PINECONE_INDEX env (defaults to `yaoainote`), EMBED_DIM=1024

## Key repository conventions and gotchas

- API auth: server expects an APP_API_KEY (server/.env or env). The frontend sends it in the `x-api-key` header. Set APP_API_KEY before starting server, and provide that value via the UI (stored in localStorage) or VITE_API_BASE_URL for prod.
- Env files: copy `server/.env.example` → `server/.env` and fill keys (ANTHROPIC_API_KEY, VOYAGE_API_KEY, PINECONE_API_KEY, PINECONE_INDEX, APP_API_KEY).
- Pinecone index and embedding dim: Voyage embeddings use 1024 dims; the code enforces EMBED_DIM === 1024 — create the Pinecone index with dimension 1024 and metric `cosine`.
- Deterministic vector ids: vectors are upserted as `${documentId}#${chunkIndex}` (see server/src/lib/pinecone.js). Deletion uses this scheme — do not change without updating DB logic.
- SSE contract: chat endpoint sends an initial `sources` event, then many `text` deltas, then a `done` event, followed by a `[DONE]` frame. Client-side parser in client/src/api.js expects that exact format.
- Upload size and memory: multer uses memoryStorage and a 50MB file limit; large files may need different handling.
- Host binding: server binds to host `0.0.0.0` by default to work on container platforms (see server/src/index.js).
- Local metadata DB: server uses a small SQLite DB under server/data/ by default; set DATA_DIR to change location for container volumes.

## Files to inspect for deeper context

- server/src/lib/* (claude.js, embed.js, pinecone.js, parse.js, chunk.js, db.js)
- server/src/routes/* (documents.js, chat.js)
- server/.env.example and server/src/index.js
- client/src/api.js and client/src/components/*
- README.md for deployment notes (Railway/Vercel) and required API keys

---

If you'd like, update this file to add local debugging commands (example curl requests for chat/document upload) or include a short sequence for reproducing a minimal end-to-end flow.
