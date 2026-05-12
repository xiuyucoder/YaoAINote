# YaoAINote

Personal AI knowledge management system. Upload your documents, ask questions in natural language, and get AI-generated answers grounded in your data with source citations.

## Stack

- **Backend:** Node.js + Express
- **Frontend:** Vite + React
- **LLM:** Claude API (`claude-opus-4-7`) with adaptive thinking + prompt caching
- **Embeddings:** Voyage AI (`voyage-3-large`)
- **Vector DB:** Pinecone (serverless)
- **Hosting:** Railway (backend) + Vercel (frontend)

## Setup

1. `cp server/.env.example server/.env` and fill in API keys.
2. From the repo root: `npm install`.
3. Start the backend: `npm run dev:server`.
4. (Once the client is scaffolded) `npm run dev:client` in another terminal.

## API keys you'll need

| Service | Where to get it |
|---|---|
| `ANTHROPIC_API_KEY` | https://console.anthropic.com/ |
| `VOYAGE_API_KEY` | https://www.voyageai.com/ |
| `PINECONE_API_KEY` | https://app.pinecone.io/ — create a serverless index named `yaoainote`, dimension `1024`, metric `cosine` |
| `APP_API_KEY` | Make up any random string — used to authenticate the frontend to the backend |
