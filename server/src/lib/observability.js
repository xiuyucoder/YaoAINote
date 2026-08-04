import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  SpanKind,
  SpanStatusCode,
  context,
  createContextKey,
  metrics,
  propagation,
  trace,
} from '@opentelemetry/api';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { Resource } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { AlwaysOnSampler } from '@opentelemetry/sdk-trace-base';

export const SERVICE_NAME = 'yaoainote-server';
export const SERVICE_VERSION = process.env.npm_package_version || '0.1.0';
export const DEPLOYMENT_ENVIRONMENT =
  process.env.DEPLOYMENT_ENVIRONMENT || process.env.NODE_ENV || 'development';

const REQUEST_CONTEXT_KEY = createContextKey('yaoainote.request');
const tracer = trace.getTracer(SERVICE_NAME, SERVICE_VERSION);
const telemetryEnabled = process.env.TELEMETRY_ENABLED === 'true';
let prometheusExporter;

function configuredSampleRatio() {
  const ratio = Number(
    process.env.TELEMETRY_TRACE_SAMPLE_RATIO ?? process.env.OTEL_TRACE_SAMPLE_RATIO ?? 0.1,
  );
  return Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0.1;
}

function isRatioSampled(traceId, ratio) {
  const sample = Number.parseInt(traceId.slice(-8), 16) / 0x1_0000_0000;
  return sample < ratio;
}

class TailSamplingSpanProcessor {
  constructor(exporter, sampleRatio) {
    this.exporter = exporter;
    this.sampleRatio = sampleRatio;
    this.traces = new Map();
  }

  onStart() {}

  onEnd(span) {
    const traceId = span.spanContext().traceId;
    const spans = this.traces.get(traceId) || [];
    spans.push(span);
    this.traces.set(traceId, spans);

    if (this.traces.size > 1000) {
      this.traces.delete(this.traces.keys().next().value);
    }
    if (span.name !== 'http.server.request') return;

    this.traces.delete(traceId);
    const rootAttributes = span.attributes;
    const isHealthCheck = rootAttributes['http.route'] === '/api/health';
    const traceHasError = spans.some((candidate) =>
      candidate.status.code === SpanStatusCode.ERROR ||
      candidate.attributes['auth.result'] === 'rejected' ||
      candidate.attributes['auth.result'] === 'misconfigured' ||
      candidate.attributes['error.type'] === 'DependencyError',
    );
    const isCancelled = rootAttributes['rag.cancelled'] === true;
    const duration = span.duration[0] * 1000 + span.duration[1] / 1e6;
    const parentWasSampled = Boolean(span.parentSpanContext?.traceFlags & 0x1);
    const shouldExport = isHealthCheck
      ? isRatioSampled(traceId, 0.01)
      : parentWasSampled ||
        isRatioSampled(traceId, this.sampleRatio) ||
        traceHasError ||
        isCancelled ||
        duration > 5000;

    if (shouldExport) this.exporter.export(spans, () => {});
  }

  forceFlush() {
    return Promise.resolve();
  }

  shutdown() {
    return this.exporter.shutdown();
  }
}

const resource = new Resource({
  'service.name': SERVICE_NAME,
  'service.version': SERVICE_VERSION,
  'deployment.environment': DEPLOYMENT_ENVIRONMENT,
  'service.instance.id': randomUUID(),
});

const sdkConfig = {
  autoDetectResources: false,
  resource,
  // TailSamplingSpanProcessor makes the final export decision after the root
  // span closes, so every trace must remain locally recordable until then.
  sampler: new AlwaysOnSampler(),
};

if (telemetryEnabled) {
  prometheusExporter = new PrometheusExporter({
    endpoint: '/metrics',
    preventServerStart: true,
  });
  sdkConfig.metricReader = prometheusExporter;

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/+$/, '');
  if (endpoint) {
    sdkConfig.spanProcessor = new TailSamplingSpanProcessor(
      new OTLPTraceExporter({
        url: endpoint.endsWith('/v1/traces') ? endpoint : `${endpoint}/v1/traces`,
      }),
      configuredSampleRatio(),
    );
  }
}

// This module is loaded before Express. Even without an exporter, registering the
// provider preserves W3C context for correlation IDs and structured request logs.
const sdk = new NodeSDK(sdkConfig);
sdk.start();

const meter = metrics.getMeter(SERVICE_NAME, SERVICE_VERSION);
const instruments = {
  httpDuration: meter.createHistogram('yaoainote.http.server.duration', { unit: 'ms' }),
  httpRequests: meter.createCounter('yaoainote.http.server.requests'),
  authRequests: meter.createCounter('yaoainote.auth.requests'),
  documentOperations: meter.createCounter('yaoainote.documents.operations'),
  uploadBytes: meter.createHistogram('yaoainote.documents.upload.bytes', { unit: 'By' }),
  parseDuration: meter.createHistogram('yaoainote.documents.parse.duration', { unit: 'ms' }),
  chunks: meter.createHistogram('yaoainote.documents.chunks'),
  embeddingsDuration: meter.createHistogram('yaoainote.embeddings.duration', { unit: 'ms' }),
  embeddingInputs: meter.createCounter('yaoainote.embeddings.inputs'),
  vectorDuration: meter.createHistogram('yaoainote.vector_db.duration', { unit: 'ms' }),
  vectors: meter.createHistogram('yaoainote.vector_db.vectors'),
  ragDuration: meter.createHistogram('yaoainote.rag.chat.duration', { unit: 'ms' }),
  retrievedChunks: meter.createHistogram('yaoainote.rag.retrieved_chunks'),
  streamDuration: meter.createHistogram('yaoainote.gen_ai.stream.duration', { unit: 'ms' }),
  tokens: meter.createCounter('yaoainote.gen_ai.tokens'),
  sseEvents: meter.createCounter('yaoainote.sse.events'),
};

function nowMs() {
  return performance.now();
}

function durationMs(started) {
  return Math.round(performance.now() - started);
}

function removeUndefined(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase();
  return (
    normalized === 'authorization' ||
    normalized === 'x-api-key' ||
    normalized === 'cookie' ||
    normalized === 'set-cookie' ||
    normalized === 'headers' ||
    normalized === 'body' ||
    normalized.endsWith('.body') ||
    normalized === 'request' ||
    normalized === 'response' ||
    normalized === 'request_body' ||
    normalized === 'response_body' ||
    normalized === 'requestbody' ||
    normalized === 'responsebody' ||
    normalized === 'query' ||
    normalized === 'text' ||
    normalized === 'prompt' ||
    normalized === 'content' ||
    normalized === 'chunks' ||
    normalized === 'sources' ||
    normalized === 'filename' ||
    normalized === 'document_name' ||
    normalized === 'documentid' ||
    normalized === 'document_id' ||
    normalized.endsWith('_key') ||
    normalized.endsWith('_token')
  );
}

function redact(value) {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return undefined;
  if (Array.isArray(value)) return value.map(redact).filter((item) => item !== undefined);

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveKey(key))
      .map(([key, child]) => [
        key,
        key === 'error' && child && typeof child === 'object'
          ? removeUndefined({ type: child.type, code: child.code })
          : redact(child),
      ])
      .filter(([, child]) => child !== undefined),
  );
}

function currentTraceFields() {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  return spanContext?.traceId
    ? { trace_id: spanContext.traceId, span_id: spanContext.spanId }
    : {};
}

function currentRequest() {
  return context.active().getValue(REQUEST_CONTEXT_KEY);
}

function requestLogFields() {
  const request = currentRequest();
  return request
    ? removeUndefined({
      request_id: request.id,
      route: request.route,
      method: request.method,
    })
    : {};
}

export function log(level, fields) {
  const record = redact(removeUndefined({
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    environment: DEPLOYMENT_ENVIRONMENT,
    ...requestLogFields(),
    ...currentTraceFields(),
    ...fields,
  }));

  process.stdout.write(`${JSON.stringify(record)}\n`);
}

export function errorInfo(error, fallbackCode = 'INTERNAL_ERROR') {
  if (error?.telemetryError) return error.telemetryError;
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') {
    return { type: 'CancellationError', code: 'REQUEST_CANCELLED' };
  }
  if (error?.code === 'LIMIT_FILE_SIZE') {
    return { type: 'ValidationError', code: 'UPLOAD_TOO_LARGE' };
  }
  if (Number(error?.status) >= 400 && Number(error?.status) < 500) {
    return { type: 'ValidationError', code: fallbackCode };
  }
  if (/^(PINECONE|VOYAGE|ANTHROPIC)_/.test(fallbackCode)) {
    return { type: 'DependencyError', code: fallbackCode };
  }
  if (fallbackCode.startsWith('SQLITE_')) {
    return { type: 'DatabaseError', code: fallbackCode };
  }
  return { type: 'ServerError', code: fallbackCode };
}

export function createHttpError(status, message, telemetryError) {
  return Object.assign(new Error(message), {
    status,
    telemetryError,
  });
}

export function outcomeForStatus(statusCode) {
  if (statusCode >= 500) return 'server_error';
  if (statusCode >= 400) return 'client_error';
  return 'success';
}

export function outcomeForError(error, fallbackCode) {
  const info = errorInfo(error, fallbackCode);
  if (info.type === 'CancellationError') return 'cancelled';
  if (info.type === 'ValidationError' || info.type === 'AuthenticationError') return 'client_error';
  if (info.type === 'DependencyError') return 'dependency_error';
  return 'server_error';
}

function levelForOutcome(outcome) {
  return outcome === 'server_error' ? 'error' : 'warn';
}

function setSpanAttributes(span, summary) {
  span.setAttributes(removeUndefined(summary));
}

function logStage(stage, outcome, duration, error) {
  const fields = {
    event: `${stage.event}.${outcome === 'success' ? 'completed' : 'failed'}`,
    message: outcome === 'success' ? stage.message : `${stage.message} failed`,
    outcome,
    duration_ms: duration,
    ...stage.summary,
  };
  if (error) fields.error = error;
  log(outcome === 'success' ? 'info' : levelForOutcome(outcome), fields);
}

/**
 * Starts a span and emits one safe completion/failure log. Callers may only put
 * approved numeric/count/allowlisted values in attributes and summary.
 */
export async function instrumentStage(config, work) {
  const started = nowMs();
  const summary = { ...config.attributes };
  const initialContext = context.active();

  return tracer.startActiveSpan(
    config.name,
    { kind: config.kind || SpanKind.INTERNAL, attributes: removeUndefined(summary) },
    initialContext,
    async (span) => {
      const stage = {
        span,
        summary,
        outcome: 'success',
        setAttribute(name, value) {
          if (value !== undefined) {
            summary[name] = value;
            span.setAttribute(name, value);
          }
        },
        setAttributes(values) {
          Object.entries(values).forEach(([name, value]) => this.setAttribute(name, value));
        },
        setOutcome(outcome) {
          this.outcome = outcome;
        },
      };

      try {
        const result = await work(stage);
        const duration = durationMs(started);
        setSpanAttributes(span, summary);
        if (stage.outcome === 'cancelled') {
          span.setAttribute('rag.cancelled', true);
        }
        logStage({ ...config, summary }, stage.outcome, duration);
        config.onComplete?.({ outcome: stage.outcome, duration, summary });
        return result;
      } catch (error) {
        const info = errorInfo(error, config.errorCode);
        const outcome = outcomeForError(error, config.errorCode);
        const duration = durationMs(started);
        setSpanAttributes(span, summary);

        if (outcome === 'cancelled') {
          span.setAttribute('rag.cancelled', true);
        } else {
          span.setAttribute('error.type', info.type);
          span.setStatus({ code: SpanStatusCode.ERROR });
        }

        logStage({ ...config, summary }, outcome, duration, info);
        config.onComplete?.({ outcome, duration, summary, error: info });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Creates a long-lived stage for aggregate operations such as SSE text delivery.
 * It intentionally avoids creating a span for each stream delta.
 */
export function startStage(config) {
  const started = nowMs();
  const summary = { ...config.attributes };
  const parentContext = context.active();
  const span = tracer.startSpan(
    config.name,
    { kind: config.kind || SpanKind.INTERNAL, attributes: removeUndefined(summary) },
    parentContext,
  );
  const stageContext = trace.setSpan(parentContext, span);
  let ended = false;

  const stage = {
    span,
    summary,
    context: stageContext,
    outcome: 'success',
    setAttribute(name, value) {
      if (value !== undefined) {
        summary[name] = value;
        span.setAttribute(name, value);
      }
    },
    setAttributes(values) {
      Object.entries(values).forEach(([name, value]) => this.setAttribute(name, value));
    },
    setOutcome(outcome) {
      this.outcome = outcome;
    },
    run(callback) {
      return context.with(stageContext, callback);
    },
    complete() {
      if (ended) return;
      ended = true;
      const duration = durationMs(started);
      setSpanAttributes(span, summary);
      if (stage.outcome === 'cancelled') span.setAttribute('rag.cancelled', true);
      context.with(stageContext, () => {
        logStage({ ...config, summary }, stage.outcome, duration);
      });
      config.onComplete?.({ outcome: stage.outcome, duration, summary });
      span.end();
    },
    fail(error) {
      if (ended) return;
      ended = true;
      const info = errorInfo(error, config.errorCode);
      const outcome = outcomeForError(error, config.errorCode);
      const duration = durationMs(started);
      setSpanAttributes(span, summary);
      if (outcome === 'cancelled') {
        span.setAttribute('rag.cancelled', true);
      } else {
        span.setAttribute('error.type', info.type);
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      context.with(stageContext, () => {
        logStage({ ...config, summary }, outcome, duration, info);
      });
      config.onComplete?.({ outcome, duration, summary, error: info });
      span.end();
    },
  };

  return stage;
}

export function annotateRoute(req, route) {
  const request = req.telemetry;
  if (!request) return;
  request.route = route;
  request.span.setAttribute('http.route', route);
}

export function markRequestError(req, error, fallbackCode = 'INTERNAL_ERROR') {
  const request = req.telemetry;
  if (!request) return;
  const info = errorInfo(error, fallbackCode);
  request.error = info;
  if (info.type !== 'CancellationError') {
    request.span.setAttribute('error.type', info.type);
    request.span.setStatus({ code: SpanStatusCode.ERROR });
  }
}

export function markRequestCancelled(req) {
  const request = req.telemetry;
  if (!request) return;
  request.cancelled = true;
  request.span.setAttribute('rag.cancelled', true);
}

export function withRequestContext(req, callback) {
  const request = req.telemetry;
  return request ? context.with(request.otelContext, callback) : callback();
}

export function requestTelemetry(req, res, next) {
  const extracted = propagation.extract(context.active(), req.headers);
  const requestId = randomUUID();
  const contentLength = Number(req.headers['content-length']);
  const span = tracer.startSpan(
    'http.server.request',
    {
      kind: SpanKind.SERVER,
      attributes: removeUndefined({
        'http.request.method': req.method,
        'url.scheme': req.protocol === 'https' ? 'https' : 'http',
        'server.address': SERVICE_NAME,
        'network.protocol.name': 'http',
        'enduser.authenticated': false,
        'request.id': requestId,
        'auth.result': 'missing',
        'http.request.body.size': Number.isFinite(contentLength) ? contentLength : undefined,
      }),
    },
    extracted,
  );

  const request = {
    id: requestId,
    method: req.method,
    route: 'unmatched',
    span,
    authenticated: false,
    authResult: 'missing',
    cancelled: false,
    error: undefined,
  };
  request.otelContext = trace.setSpan(extracted, span).setValue(REQUEST_CONTEXT_KEY, request);
  req.telemetry = request;
  res.setHeader('x-request-id', requestId);

  let complete = false;
  const finish = () => {
    if (complete) return;
    complete = true;

    // res.end() synchronously emits finish. Defer the root's completion until
    // this turn's child-stage promises settle, so server spans remain parents.
    setImmediate(() => {
      withRequestContext(req, () => {
        const duration = durationMs(request.started);
        const statusCode = res.statusCode || 500;
        const outcome = request.cancelled ? 'cancelled' : outcomeForStatus(statusCode);
        request.span.setAttributes({
          'http.route': request.route,
          'http.response.status_code': statusCode,
          'enduser.authenticated': request.authenticated,
          'auth.result': request.authResult,
        });

        if (outcome === 'cancelled') {
          request.span.setAttribute('rag.cancelled', true);
        } else if (statusCode >= 400 && !request.error) {
          request.span.setAttribute('error.type', statusCode >= 500 ? 'ServerError' : 'ValidationError');
          request.span.setStatus({ code: SpanStatusCode.ERROR });
        }

        instruments.httpDuration.record(duration, {
          route: request.route,
          method: request.method,
          status_code: String(statusCode),
          outcome,
        });
        instruments.httpRequests.add(1, {
          route: request.route,
          method: request.method,
          status_code: String(statusCode),
          outcome,
        });

        log(outcome === 'success' ? 'info' : levelForOutcome(outcome), {
          event: 'http.request.completed',
          message: 'HTTP request completed',
          outcome,
          duration_ms: duration,
          status_code: statusCode,
          auth_result: request.authResult,
          error: request.error,
        });
        request.span.end();
      });
    });
  };

  request.started = nowMs();
  res.once('finish', finish);
  res.once('close', finish);
  context.with(request.otelContext, next);
}

export function downstreamHeaders() {
  const headers = {};
  propagation.inject(context.active(), headers);
  const request = currentRequest();
  if (request?.id) headers['x-request-id'] = request.id;
  return headers;
}

export function safeFileExtension(name) {
  const extension = String(name || '').split('.').pop()?.toLowerCase();
  return ['txt', 'md', 'pdf', 'docx'].includes(extension) ? extension : 'other';
}

export function safeMimeFamily(mimeType) {
  const family = String(mimeType || '').split('/')[0].toLowerCase();
  return ['application', 'text'].includes(family) ? family : 'other';
}

export function roundScore(score) {
  return Number.isFinite(score) ? Math.round(score * 1000) / 1000 : undefined;
}

export function recordAuth(result) {
  instruments.authRequests.add(1, { result });
}

export function recordDocumentOperation(operation, outcome) {
  instruments.documentOperations.add(1, { operation, outcome });
}

export function recordUploadBytes(bytes, fileExtension, outcome) {
  instruments.uploadBytes.record(bytes, { file_extension: fileExtension, outcome });
}

export function recordParseDuration(duration, fileExtension, outcome) {
  instruments.parseDuration.record(duration, { file_extension: fileExtension, outcome });
}

export function recordChunks(count, fileExtension) {
  instruments.chunks.record(count, { file_extension: fileExtension });
}

export function recordEmbedding(duration, inputType, outcome, inputCount) {
  instruments.embeddingsDuration.record(duration, { input_type: inputType, outcome });
  instruments.embeddingInputs.add(inputCount, { input_type: inputType, outcome });
}

export function recordVector(duration, operation, outcome, vectorCount) {
  instruments.vectorDuration.record(duration, { operation, outcome });
  instruments.vectors.record(vectorCount, { operation });
}

export function recordRag(duration, outcome, noContext) {
  instruments.ragDuration.record(duration, { outcome, no_context: String(Boolean(noContext)) });
}

export function recordRetrievedChunks(count, outcome) {
  instruments.retrievedChunks.record(count, { outcome });
}

export function recordStream(duration, model, outcome, stopReason) {
  instruments.streamDuration.record(duration, {
    model,
    outcome,
    stop_reason: stopReason || 'unknown',
  });
}

export function recordTokens(model, inputTokens, outputTokens) {
  if (Number.isFinite(inputTokens)) {
    instruments.tokens.add(inputTokens, { model, token_type: 'input' });
  }
  if (Number.isFinite(outputTokens)) {
    instruments.tokens.add(outputTokens, { model, token_type: 'output' });
  }
}

export function recordSseEvent(eventType, outcome) {
  instruments.sseEvents.add(1, { event_type: eventType, outcome });
}

export function prometheusHandler(req, res) {
  if (!prometheusExporter) return false;
  prometheusExporter.getMetricsRequestHandler(req, res);
  return true;
}

export function isPrometheusEnabled() {
  return Boolean(prometheusExporter);
}

export async function shutdownTelemetry() {
  await sdk.shutdown();
}
