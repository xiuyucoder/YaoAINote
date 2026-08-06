# API Debugging Guide

This guide describes how to debug the local server APIs from PowerShell. It is
intended for engineers working on the server, retrieval pipeline, or LLM
integration.

## Prerequisites

1. Install dependencies from the repository root:

   ```powershell
   npm ci
   ```

2. Copy `server/.env.example` to `server/.env` and configure:

   - `APP_API_KEY`
   - `VOYAGE_API_KEY`
   - `PINECONE_API_KEY` and `PINECONE_INDEX`
   - `ANTHROPIC_API_KEY` for requests that retrieve matching chunks

3. Upload a document if you want to exercise the complete retrieval and LLM
   path. Without matching chunks, `/api/chat` returns its normal no-context
   fallback without calling Anthropic.

## Start the local server

For ordinary development, use the watch-mode server:

```powershell
npm run dev:server
```

For a stable debugging session with structured logs captured locally, use a
second PowerShell window and start the non-watch server:

```powershell
$env:TELEMETRY_ENABLED = 'true'
$env:TELEMETRY_TRACE_SAMPLE_RATIO = '1'

npm --workspace=server start 2>&1 |
  Tee-Object -FilePath .\server-chat-trace.log
```

`server-chat-trace.log` is a local debugging artifact. Do not commit it.

## Check server availability

The health endpoint does not require an API key:

```powershell
Invoke-RestMethod -Uri 'http://localhost:3001/api/health'
```

The expected result is:

```json
{ "ok": true }
```

If the server uses a different `PORT`, replace `3001` in every command below.

## Call `/api/chat` manually

In a separate PowerShell window, set the application API key and issue an
authenticated request:

```powershell
$apiKey = '<value of APP_API_KEY in server/.env>'

$response = Invoke-RestMethod `
  -Uri 'http://localhost:3001/api/chat' `
  -Method Post `
  -Headers @{ 'x-api-key' = $apiKey } `
  -ContentType 'application/json' `
  -Body (@{
    query = '请总结已上传文档的核心内容'
    topK = 1
  } | ConvertTo-Json) `
  -ResponseHeadersVariable responseHeaders

$response.answer
$response.sources
```

`query` must be a non-empty string. `topK` is optional, defaults to `8`, and
is capped at `20`.

The response is JSON with `answer`, `sources`, `usage`, and `stopReason`.
`sources` can be empty when no indexed document chunks match the query.

## Correlate a request with its trace

The server returns an opaque `x-request-id` response header. Capture it after
the request:

```powershell
$requestId = $responseHeaders['x-request-id']
$requestId
```

Find all structured log entries for that request and display the trace and
stage summaries:

```powershell
Select-String -Path .\server-chat-trace.log -Pattern $requestId |
  ForEach-Object { $_.Line | ConvertFrom-Json } |
  Select-Object trace_id, span_id, event, outcome, duration_ms
```

All entries for a request share one `trace_id`. Typical successful chat stages
are `auth.api_key`, `embeddings.query`, `vector_db.query`,
`rag.prompt.build`, `gen_ai.chat.request`, `rag.chat`, and
`http.request`.

Normal structured logs provide local trace correlation even when no collector
is configured. To export OpenTelemetry traces to a local collector, configure
its non-secret endpoint before starting the server:

```powershell
$env:OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318'
```

The server exports to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` unless the
endpoint already ends in `/v1/traces`. Do not add telemetry credentials or
authorization headers to `server/.env`.

## Run the opt-in live probes

The direct Anthropic probe validates the configured Anthropic-compatible
gateway without involving retrieval:

```powershell
$env:RUN_LLM_LIVE_TESTS = 'true'
npm --workspace=server run test:llm-live
```

The local chat API probe calls the running server and exercises API key
validation, Voyage embedding, Pinecone retrieval, and, when context is found,
Anthropic:

```powershell
$env:RUN_CHAT_API_LIVE_TESTS = 'true'
npm --workspace=server run test:chat-api-live
```

The chat API probe reads `APP_API_KEY` from `server/.env`. Set
`CHAT_API_KEY` to use a different key, or `CHAT_API_BASE_URL` to use a
different local address. The test restricts the target to `localhost`,
`127.0.0.1`, or `::1`.

Both live probes make provider requests and can consume quota. They are
disabled by default.

## Troubleshooting

| Symptom                       | Likely cause and action                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| Connection refused            | Start the server and verify the configured `PORT`.                                                     |
| `401` response                | Check that `x-api-key` exactly matches `APP_API_KEY`.                                                  |
| `500` response                | Use `x-request-id` to find the corresponding structured logs and identify the failed stage.            |
| No-context fallback           | Upload documents, confirm they were indexed successfully, or use a more relevant query.                |
| `embeddings.query` failure    | Verify `VOYAGE_API_KEY` and network access to Voyage.                                                  |
| `vector_db.query` failure     | Verify `PINECONE_API_KEY`, `PINECONE_INDEX`, and that the index uses 1024 dimensions.                  |
| `gen_ai.chat.request` failure | Verify `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` when using a relay, and provider availability.        |
| No trace in a collector       | Set `TELEMETRY_ENABLED=true` and a reachable `OTEL_EXPORTER_OTLP_ENDPOINT` before starting the server. |

## Telemetry safety

Normal logs and traces intentionally contain only safe metadata: route,
duration, outcome, counts, model identifiers, and opaque request/trace IDs.
They do not include API keys, request bodies, prompts, document text, source
chunks, or model answers. Keep raw debug capture disabled unless it has been
explicitly approved for an incident.
