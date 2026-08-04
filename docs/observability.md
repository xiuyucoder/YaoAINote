# Observability contract

This document is the implementation contract for telemetry in YaoAINote. It
applies to the Express API and React client. Instrumentation uses OpenTelemetry
traces, metrics, and JSON logs; it must not change API or SSE behavior.

## Shared conventions

- Resource attributes are `service.name` (`yaoainote-server` or
  `yaoainote-client`), `service.version`, `deployment.environment`, and
  `service.instance.id` (server only). `service.instance.id` is an ephemeral
  deployment identifier, never a host name or user name.
- A server request creates or continues a W3C `traceparent` trace. Return the
  generated/request correlation ID in `x-request-id`, include it in every
  request log, and propagate it to downstream calls. The client creates a
  trace for an interaction and propagates `traceparent` when browser policy
  permits.
- Use stable, lowercase dotted span names and semantic-convention HTTP
  attributes. Route attributes use templates (for example,
  `http.route=/api/documents/:id`), never a raw path or query string.
- Add `error.type` (a stable error class/code, not an error message) and set
  span status to `ERROR` on failures. Cancellation is `UNSET`, with
  `rag.cancelled=true`, rather than an error.
- Durations are recorded by span timing and histograms in milliseconds. Counts,
  byte sizes, character counts, token counts, chunk counts, and result counts
  are numeric attributes and metric values.

## Trace contract

The HTTP server span is the parent of every stage below. Its standard
attributes are `http.request.method`, `http.response.status_code`, `http.route`,
`url.scheme`, `server.address` (service address only), `network.protocol.name`,
and `enduser.authenticated` (`true` or `false`). Do not put request headers,
client IP addresses, user agents, API keys, or request bodies on a span.

| Area | Required span name | Required attributes beyond shared conventions |
| --- | --- | --- |
| Browser document list | `ui.documents.list` | `ui.operation=list`, `http.response.status_code` |
| Browser upload | `ui.documents.upload` | `ui.operation=upload`, `upload.file_count`, `upload.total_bytes`, `ui.result` (`success`, `error`, `cancelled`) |
| Browser delete | `ui.documents.delete` | `ui.operation=delete`, `ui.result` |
| Browser question | `ui.chat.submit` | `ui.operation=ask`, `rag.requested_top_k`, `ui.result` |
| Browser SSE consumption | `ui.chat.stream` | `sse.event_count`, `sse.text_delta_count`, `sse.text_bytes`, `sse.stop_reason`, `rag.cancelled` |
| Browser answer feedback | `ui.chat.feedback` | `ui.operation=feedback`, `feedback.reason_code` (allowlisted), `ui.result` |
| API request | `http.server.request` | HTTP attributes above, `request.id`, `auth.result` (`accepted`, `missing`, `rejected`, `misconfigured`) |
| Health endpoint | `health.check` | `health.status=ok` |
| API-key check | `auth.api_key` | `auth.result`; never key, hash, length, or comparison detail |
| List documents | `documents.list` | `documents.count` |
| Upload workflow | `documents.upload` | `upload.file_extension` (allowlisted), `upload.bytes`, `document.text_chars`, `document.chunk_count`, `documents.result` |
| Parse upload | `documents.parse` | `document.file_extension`, `upload.bytes`, `document.text_chars`, `parser.result` |
| Chunk text | `documents.chunk` | `document.text_chars`, `chunk.target_tokens`, `chunk.overlap_tokens`, `document.chunk_count`, `chunk.total_chars` |
| Embed document batches | `embeddings.documents` | `gen_ai.system=voyage`, `gen_ai.request.model=voyage-3-large`, `embedding.input_type=document`, `embedding.chunk_count`, `embedding.batch_count`, `embedding.input_chars`, `embedding.vector_dimension=1024` |
| One embedding HTTP batch | `embeddings.batch` | preceding model attributes, `embedding.batch_index`, `embedding.batch_size`, `http.response.status_code` |
| Pinecone upsert | `vector_db.upsert` | `db.system=pinecone`, `db.operation=upsert`, `vector.count`, `vector.batch_count`, `embedding.vector_dimension` |
| SQLite document insert | `metadata.insert` | `db.system=sqlite`, `db.operation=insert`, `document.size_bytes`, `document.chunk_count` |
| Delete workflow | `documents.delete` | `document.chunk_count`, `documents.result` |
| Pinecone delete | `vector_db.delete` | `db.system=pinecone`, `db.operation=delete`, `vector.count`, `vector.batch_count` |
| SQLite document delete | `metadata.delete` | `db.system=sqlite`, `db.operation=delete` |
| Chat workflow | `rag.chat` | `rag.query_chars`, `rag.requested_top_k`, `rag.retrieved_count`, `rag.no_context`, `rag.cancelled`, `sse.stop_reason` |
| Answer feedback | `chat.feedback` | `feedback.reason_code` (`useful`, `not_useful_incorrect`, `not_useful_incomplete`, `not_useful_irrelevant`, or `not_useful_other`), `feedback.validation_result` |
| Embed query | `embeddings.query` | `gen_ai.system=voyage`, `gen_ai.request.model=voyage-3-large`, `embedding.input_type=query`, `embedding.input_chars=rag.query_chars`, `embedding.vector_dimension=1024` |
| Pinecone query | `vector_db.query` | `db.system=pinecone`, `db.operation=query`, `vector.top_k`, `vector.result_count`, `vector.score_max`, `vector.score_min` |
| Build LLM request | `rag.prompt.build` | `rag.retrieved_count`, `rag.context_chars`, `rag.context_chunk_count`, `gen_ai.request.model=claude-sonnet-4-6`, `gen_ai.request.max_tokens=16000` |
| Claude stream | `gen_ai.chat.stream` | `gen_ai.system=anthropic`, `gen_ai.request.model=claude-sonnet-4-6`, `gen_ai.operation.name=chat`, `gen_ai.request.max_tokens=16000`, `gen_ai.response.stop_reason`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `sse.text_delta_count`, `sse.text_bytes` |
| Emit sources | `sse.sources.emit` | `rag.retrieved_count`, `sse.payload_bytes` |
| Emit text/done/error | `sse.response.emit` | `sse.event_type` (`text`, `done`, `error`), `sse.payload_bytes`, `sse.stop_reason` when available |

Create one child span per external request/batch, rather than one per vector,
chunk, token, or SSE text delta. `sse.response.emit` may represent aggregate
text delivery for a stream, while counters record event totals. Do not create a
span for each delta.

## Metric contract

All metric names are prefixed with `yaoainote.`. Histograms use milliseconds
unless the unit is named in the metric. Metrics have the resource attributes
above plus only the labels listed here.

| Metric | Type | Labels |
| --- | --- | --- |
| `yaoainote.http.server.duration` | histogram | `route`, `method`, `status_code`, `outcome` |
| `yaoainote.http.server.requests` | counter | `route`, `method`, `status_code`, `outcome` |
| `yaoainote.auth.requests` | counter | `result` |
| `yaoainote.documents.operations` | counter | `operation` (`list`, `upload`, `delete`), `outcome` |
| `yaoainote.documents.upload.bytes` | histogram, bytes | `file_extension`, `outcome` |
| `yaoainote.documents.parse.duration` | histogram | `file_extension`, `outcome` |
| `yaoainote.documents.chunks` | histogram | `file_extension` |
| `yaoainote.embeddings.duration` | histogram | `input_type`, `outcome` |
| `yaoainote.embeddings.inputs` | counter | `input_type`, `outcome` |
| `yaoainote.vector_db.duration` | histogram | `operation` (`query`, `upsert`, `delete`), `outcome` |
| `yaoainote.vector_db.vectors` | histogram | `operation` |
| `yaoainote.rag.chat.duration` | histogram | `outcome`, `no_context` |
| `yaoainote.rag.retrieved_chunks` | histogram | `outcome` |
| `yaoainote.gen_ai.stream.duration` | histogram | `model`, `outcome`, `stop_reason` |
| `yaoainote.gen_ai.tokens` | counter | `model`, `token_type` (`input`, `output`) |
| `yaoainote.sse.events` | counter | `event_type`, `outcome` |
| `yaoainote.client.interactions` | counter | `operation` (`list`, `upload`, `delete`, `ask`, or `feedback`), `outcome` |
| `yaoainote.client.request.duration` | histogram | `route`, `method`, `outcome` |

`outcome` is one of `success`, `client_error`, `server_error`, `cancelled`, or
`dependency_error`. `file_extension` is one of `txt`, `md`, `pdf`, `docx`, or
`other`; `model` is an allowlisted configured model name. Labels must be
bounded, low-cardinality enums. Never use request ID, trace ID, document ID or
name, index name, error message/type, URL, user identity, raw status text,
token count, byte count, score, or timestamp as a metric label. Put changing
numeric values in observations and diagnostic dimensions in traces/logs.

## Dashboards and alerting

The provisioned Grafana dashboards use the Prometheus representation of the
metric contract: dots become underscores (for example
`yaoainote.http.server.duration` becomes
`yaoainote_http_server_duration_bucket`), and counters end in `_total`.
Queries aggregate only by the bounded contract labels such as
`route`, `outcome`, `operation`, `file_extension`, and `status_code`; they do
not expose resource instance IDs or diagnostic identifiers.

Dashboard coverage is API/SLO, RAG/provider health, upload ingestion, search
quality, and telemetry pipeline/capacity. Search quality is represented only
by safe proxies: successful no-context rate, retrieved-chunk count, and vector
query behavior. It does not infer relevance from document or query content.

TTFT is intentionally not estimated. The current contract and implementation
provide full `yaoainote.gen_ai.stream.duration`, SSE event counts, and client
request duration, but no bounded time-to-first-token histogram. The RAG
dashboard marks this limitation explicitly. Add a contract-approved,
low-cardinality TTFT histogram and instrument it before adding a TTFT graph or
alert.

Prometheus alerts carry the routing labels `service=yaoainote`,
`team=platform`, `component`, and `severity`; Alertmanager groups by those
labels. Production Alertmanager receiver configuration is deployment-managed
and secret-backed. The local stack's receiver is a deliberate discard sink.

## Structured logs

Emit newline-delimited JSON at `info` for completed operations, `warn` for
expected client/dependency failures, and `error` for server failures. Every log
has this schema:

```json
{
  "timestamp": "2026-08-04T06:08:15.437Z",
  "level": "info",
  "service": "yaoainote-server",
  "environment": "production",
  "event": "rag.chat.completed",
  "message": "RAG chat completed",
  "request_id": "opaque-correlation-id",
  "trace_id": "otel-trace-id",
  "span_id": "otel-span-id",
  "route": "/api/chat",
  "method": "POST",
  "outcome": "success",
  "duration_ms": 123,
  "error": { "type": "DependencyError", "code": "ANTHROPIC_STREAM_FAILED" }
}
```

`error` is omitted when there is no error. `message` is a fixed template, not
an exception message. Event-specific safe fields follow the stage summaries
below. Logger redaction is mandatory and runs before export; it removes
`authorization`, `x-api-key`, `cookie`, `set-cookie`, all `*_KEY` and
`*_TOKEN` fields, request/response bodies, and nested equivalents.

## Safe stage-level input and output summaries

Instrument every completed or failed stage with the following summaries in its
span and corresponding completion/failure log. These are the only permitted
representations of application input and output in normal telemetry.

| Stage | Safe input summary | Safe output summary |
| --- | --- | --- |
| HTTP/API key | route template, method, content length if known | status code, auth result, duration |
| Upload receive | allowlisted extension, MIME family if available, file byte size, file count | accepted/rejected reason code; never filename or file bytes |
| Parse | extension, source byte size | text character count, non-empty boolean, parser result |
| Chunk | text character count, configured target/overlap tokens | chunk count, total/min/max/mean chunk character count |
| Document embedding | chunk count, batch sizes, total character count, fixed model/input type | vector count, dimension, batch count, provider status |
| Pinecone upsert/delete | vector count and batch count | completed batch count, provider status |
| SQLite metadata | operation and numeric size/chunk count | affected row count |
| Chat input | query character count, requested top-K | validation result only |
| Answer feedback | validation of an opaque request ID and allowlisted reason code | accepted/rejected validation result; never the request ID |
| Query embedding | query character count, fixed model/input type | vector dimension, provider status |
| Pinecone query | top-K, vector dimension | result count, min/max score rounded to three decimals; no result IDs, names, or text |
| Prompt construction | retrieved chunk count and aggregate context character count | model, maximum tokens, final prompt character count; no prompt/context |
| Claude stream | model, maximum tokens, aggregate prompt size | stop reason, input/output tokens if returned, delta count, output character/byte count |
| SSE | event type and aggregate payload byte count | delivered event count, close/cancel status |
| Client UI | fixed operation name and aggregate upload bytes/query character count | success/error/cancelled and elapsed time |

Document IDs are opaque but are still excluded from normal telemetry to avoid
linkability. Filenames, document text, chunks, prompts, queries, model answers,
source snippets, embeddings, API keys, authentication headers, IP addresses,
and full exception messages are never safe summaries.

## Privacy, retention, and access

1. Normal traces, metrics, and logs contain only this contract's summaries.
   Disable SDK body/header capture and GenAI prompt/completion content capture.
2. Do not derive identities from `APP_API_KEY`; do not log it, hash it, or use
   it as a telemetry attribute. The product currently has no user ID, and none
   should be invented for telemetry.
3. Retain normal telemetry according to the approved platform retention policy.
   Access is least-privilege and audited; production telemetry is not exported
   to developer devices or public analytics services.
4. Redact before queueing, sampling, and exporting so that a failed exporter
   cannot expose content in local buffers or error logs.

### Restricted raw debug capture

Raw capture exists only for a time-bounded incident investigation. It is
disabled by default and requires both `TELEMETRY_RAW_DEBUG_ENABLED=true` and an
approved incident/change reference in the deployment configuration. It is not
an OpenTelemetry exporter, must never be sent to browser telemetry, and must
not contain credentials, authentication headers, cookies, or environment
variables.

When approved, raw capture may store the minimum selected request, parsed
text, chunks, retrieved context, prompt, model response, and provider error
body required to reproduce that incident. Store records separately from normal
telemetry using per-record envelope encryption with the approved managed key,
encrypted transport, strict incident-role access, and an immutable access
audit record. Retain exactly seven days: automated deletion must run at or
before the expiry timestamp, delete encrypted payloads and key material, and
emit only a non-content `raw_debug_capture.deleted` audit event. Do not
back up, copy, index, train on, or use these records for analytics. Disable the
feature and revoke incident access when the incident closes.

## Sampling and exporter configuration

- Production server root traces use parent-based ratio sampling at 10% by
  default. Child spans follow the parent decision. Client interaction traces
  use the same 10% ratio.
- Always retain traces with an error status, `auth.result=rejected` or
  `misconfigured`, dependency failures, and server-side cancellations after
  work began. Tail-sample successful root traces slower than 5 seconds.
- Health checks are sampled at 1% and never promote their children. Metrics
  and error logs are not trace-sampled.
- Sampling must occur after redaction for logs and cannot override the raw
  content prohibition. Changes to ratios, slow threshold, or retention require
  an operational change record.
- Configure an OTLP endpoint only through a non-secret endpoint setting and
  platform workload identity. Do not add telemetry API keys, authorization
  headers, or other secrets to `.env` files.

`server/.env.example` documents the supported non-secret settings. Missing
settings leave telemetry disabled; raw debug capture remains disabled unless
explicitly enabled and approved.
