# Local observability stack

This is a self-hosted development stack for the telemetry contract in
[`docs/observability.md`](../docs/observability.md). It provides Grafana,
Prometheus, Loki, Tempo, an OpenTelemetry Collector, and Alertmanager without
changing the application or sending telemetry to a third party.

## Run locally

```powershell
cd observability
Copy-Item .env.example .env
# Set a strong local-only GRAFANA_ADMIN_PASSWORD in .env
docker compose up -d
docker compose ps
```

Open Grafana at <http://localhost:3000>. Prometheus, Loki, Tempo, and
Alertmanager are available at ports `9090`, `3100`, `3200`, and `9093`.
Persistent named volumes retain their data across restarts. Stop the stack with
`docker compose down`; use `docker compose down -v` only when deliberately
discarding all local telemetry.

The Collector receives OTLP/gRPC at `localhost:4317` and OTLP/HTTP at
`http://localhost:4318`. Configure local instrumented processes with that
non-secret endpoint and the resource attributes mandated by the telemetry
contract. Browser OTLP is restricted to Vite's local origins. Logs must be
redacted by the application before export; this stack does not relax the
contract's content restrictions.

The server's Prometheus exporter is scraped directly because it exposes the
contract metrics at `/metrics`. The supplied local target is
`host.docker.internal:3001`; start the server on that port with telemetry
enabled (and optionally point traces to the Collector):

```powershell
cd ..
$env:PORT = "3001"
$env:TELEMETRY_ENABLED = "true"
$env:OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318"
node server/src/index.js
```

For a non-local deployment, replace
`prometheus/targets/yaoainote-server.yml` through deployment configuration
with the approved server target(s). Do not add unbounded target labels.

Grafana provisions Prometheus, Loki, Tempo, and these dashboards:

- **YaoAINote API & SLO** — request volume, availability, status codes, and
  p95/p99 HTTP latency.
- **YaoAINote RAG Performance** — RAG and stream latency, dependency errors,
  tokens, and SSE delivery. It explicitly identifies that TTFT is not yet
  instrumented instead of misrepresenting stream duration as TTFT.
- **YaoAINote Upload Ingestion** — upload outcomes, parse latency, dependency
  latency, size, and chunking.
- **YaoAINote Search Quality** — no-context rate, retrieved chunks, and vector
  query health.
- **YaoAINote Observability Pipeline & Capacity** — scrape health, Collector
  queues/failures, cardinality, memory, and received telemetry.

Prometheus evaluates API/SLO, RAG/provider, ingestion/search-quality, and
pipeline alerts. Every alert includes `service=yaoainote`, `team=platform`,
`component`, and `severity`, and Alertmanager groups on that routing metadata.
The local `local-discard` receiver intentionally discards notifications.
Production deployments must replace it through a secret-managed Alertmanager
configuration with the appropriate paging/ticket receivers; never commit
receiver credentials.

## Retention and production

Loki retains logs for **30 days** (`720h`), and Tempo retains traces for
**14 days** (`336h`). These filesystem-backed single-node settings are for
local development only and must not be treated as a production topology.

For Kubernetes, deploy these components with supported Helm charts or
operators; use workload identity, TLS, NetworkPolicies, resource
requests/limits, readiness probes, and secret-managed Grafana/Alertmanager
credentials. Use scalable Loki and Tempo modes backed by an approved encrypted
object store (rather than local disks), configure retention/lifecycle policies
there, and run compaction as documented by each project. Keep Grafana,
Prometheus, and Alertmanager state on managed persistent volumes. Restrict
telemetry access with least privilege and auditing, and keep production
telemetry out of developer devices and public analytics services.
