# YaoAINote

Personal AI knowledge management system. Upload your documents, ask questions in natural language, and get AI-generated answers grounded in your data with source citations.

## Stack

- **Backend:** Node.js + Express
- **Frontend:** Vite + React
- **LLM:** Claude API
- **Embeddings:** Voyage AI (`voyage-3-large`)
- **Vector DB:** Pinecone (serverless)
- **Hosting:** Railway (backend) + Vercel (frontend)

## Setup

1. `cp server/.env.example server/.env` and fill in API keys.
2. From the repo root: `npm install`.
3. Start the backend: `npm run dev:server`.
4. (Once the client is scaffolded) `npm run dev:client` in another terminal.

## API keys you'll need

| Service             | Where to get it                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/                                                                            |
| `VOYAGE_API_KEY`    | https://www.voyageai.com/                                                                                 |
| `PINECONE_API_KEY`  | https://app.pinecone.io/ — create a serverless index named `yaoainote`, dimension `1024`, metric `cosine` |
| `APP_API_KEY`       | Make up any random string — used to authenticate the frontend to the backend                              |

## Git hooks (developer workflow)

This repository uses Husky and lint-staged to run quick checks on staged files and run workspace tests before pushing.

- Installation: run `npm install` at the repo root. Husky will be installed as a dev dependency and the `prepare` script will configure hooks (`husky install`).
- Pre-commit: runs `lint-staged` to format staged files with Prettier and run lightweight checks.
- Pre-push: runs `npm run test` in each workspace (if the workspace defines a `test` script).

To bypass hooks: use `git commit --no-verify` or `git push --no-verify` when necessary.

## LLM diagnostic tests

Run safe, offline LLM unit tests without contacting a provider:

```powershell
npm --workspace=server test
```

To probe the configured Anthropic-compatible gateway with a minimal streaming request,
enable it explicitly. This consumes a small number of tokens and requires
`ANTHROPIC_API_KEY` (plus `ANTHROPIC_BASE_URL` when using a relay):

```powershell
$env:RUN_LLM_LIVE_TESTS = 'true'
npm --workspace=server run test:llm-live
```

The live test emits JSON records named `llm.live_probe.started`,
`llm.live_probe.completed`, or `llm.live_probe.failed`. They include the endpoint
origin, model, request ID, request field names, duration, token counts, provider request
ID, and sanitized provider status/type/code. They intentionally exclude API keys, header
values, prompts, document chunks, and raw provider responses.

## Local chat API probe

Start the configured backend in one terminal:

```powershell
npm run dev:server
```

In another terminal, run the opt-in `/api/chat` probe. It sends an authenticated request
to `http://localhost:3001/api/chat`; the server performs its normal embedding, retrieval,
and (when matching documents exist) LLM request:

```powershell
$env:RUN_CHAT_API_LIVE_TESTS = 'true'
npm --workspace=server run test:chat-api-live
```

The probe reads `APP_API_KEY` from `server/.env`. To target a different local port or use
a separate key, set `CHAT_API_BASE_URL` (restricted to `localhost`, `127.0.0.1`, or `::1`)
and `CHAT_API_KEY` before running it.

For PowerShell API calls, trace correlation, live probes, and troubleshooting,
see [the API debugging guide](docs/api-debugging.md).
