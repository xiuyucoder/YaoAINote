import {
  context,
  isSpanContextValid,
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';

const SERVICE_NAME = 'yaoainote-client';
const DEFAULT_SAMPLE_RATIO = 0.1;
const UI_RESULTS = new Set(['success', 'client_error', 'server_error', 'cancelled', 'dependency_error']);

const telemetry = {
  enabled: false,
  initialized: false,
  meterProvider: null,
  requestDuration: null,
  traceProvider: null,
  tracer: trace.getTracer(SERVICE_NAME),
  uiInteractions: null,
};

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function getSampleRatio() {
  const configured = Number(import.meta.env.VITE_OTEL_TRACE_SAMPLE_RATIO);
  return Number.isFinite(configured) && configured >= 0 && configured <= 1
    ? configured
    : DEFAULT_SAMPLE_RATIO;
}

function signalEndpoint(baseEndpoint, configuredEndpoint, signal) {
  if (configuredEndpoint) return configuredEndpoint;
  if (!baseEndpoint) return '';

  const base = baseEndpoint.replace(/\/+$/, '');
  return /\/v1\/(?:traces|metrics)$/.test(base)
    ? base.replace(/\/v1\/(?:traces|metrics)$/, `/v1/${signal}`)
    : `${base}/v1/${signal}`;
}

function setAttributes(span, attributes) {
  for (const [key, value] of Object.entries(attributes)) {
    if (
      typeof value === 'string'
      || typeof value === 'boolean'
      || (typeof value === 'number' && Number.isFinite(value))
    ) {
      span.setAttribute(key, value);
    }
  }
}

function operationSpan(operationOrSpan) {
  return operationOrSpan?.span || operationOrSpan;
}

function outcomeToUiResult(outcome) {
  if (outcome === 'success' || outcome === 'cancelled') return outcome;
  return 'error';
}

function normalizedOutcome(outcome) {
  return UI_RESULTS.has(outcome) ? outcome : 'dependency_error';
}

function flushTelemetry() {
  telemetry.traceProvider?.forceFlush?.().catch(() => {});
  telemetry.meterProvider?.forceFlush?.().catch(() => {});
}

function emitWebVital(name, value) {
  if (!Number.isFinite(value)) return;

  const vital = startSpan(`ui.web_vital.${name.toLowerCase()}`, {
    'ui.operation': 'web_vital',
    'web_vital.name': name,
    'web_vital.value': value,
  });
  endSpan(vital);
}

function observeWebVitals() {
  if (typeof PerformanceObserver === 'undefined') return;

  let largestContentfulPaint = null;
  let cumulativeLayoutShift = 0;
  let maxInteractionLatency = null;
  let vitalsFlushed = false;

  const observe = (type, callback) => {
    try {
      const observer = new PerformanceObserver((list) => callback(list.getEntries()));
      observer.observe({ type, buffered: true });
    } catch {
      // The entry type is not supported by this browser.
    }
  };

  observe('paint', (entries) => {
    const firstContentfulPaint = entries.find((entry) => entry.name === 'first-contentful-paint');
    if (firstContentfulPaint) emitWebVital('FCP', firstContentfulPaint.startTime);
  });

  observe('largest-contentful-paint', (entries) => {
    largestContentfulPaint = entries[entries.length - 1] || largestContentfulPaint;
  });

  observe('layout-shift', (entries) => {
    for (const entry of entries) {
      if (!entry.hadRecentInput) cumulativeLayoutShift += entry.value;
    }
  });

  observe('event', (entries) => {
    for (const entry of entries) {
      if (entry.interactionId && (!maxInteractionLatency || entry.duration > maxInteractionLatency)) {
        maxInteractionLatency = entry.duration;
      }
    }
  });

  const flushVitals = () => {
    if (vitalsFlushed) return;
    vitalsFlushed = true;
    emitWebVital('LCP', largestContentfulPaint?.startTime);
    emitWebVital('CLS', cumulativeLayoutShift);
    emitWebVital('INP', maxInteractionLatency);
  };

  window.addEventListener('pagehide', () => {
    flushVitals();
    flushTelemetry();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushVitals();
      flushTelemetry();
    }
  });
}

export function initializeTelemetry() {
  if (telemetry.initialized) return telemetry.enabled;
  telemetry.initialized = true;

  const baseEndpoint = import.meta.env.VITE_OTEL_EXPORTER_OTLP_ENDPOINT;
  const tracesEndpoint = signalEndpoint(
    baseEndpoint,
    import.meta.env.VITE_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    'traces',
  );
  const metricsEndpoint = signalEndpoint(
    baseEndpoint,
    import.meta.env.VITE_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    'metrics',
  );

  if (import.meta.env.VITE_TELEMETRY_ENABLED === 'false' || !tracesEndpoint || !metricsEndpoint) {
    return false;
  }

  try {
    const resource = new Resource({
      'service.name': SERVICE_NAME,
      'service.version': import.meta.env.VITE_APP_VERSION || '0.1.0',
      'deployment.environment': import.meta.env.VITE_DEPLOYMENT_ENVIRONMENT || import.meta.env.MODE,
    });
    const traceProvider = new WebTracerProvider({
      resource,
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(getSampleRatio()),
      }),
    });
    traceProvider.addSpanProcessor(
      new BatchSpanProcessor(new OTLPTraceExporter({ url: tracesEndpoint })),
    );
    traceProvider.register();

    const meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: metricsEndpoint }),
        }),
      ],
    });
    metrics.setGlobalMeterProvider(meterProvider);

    telemetry.enabled = true;
    telemetry.meterProvider = meterProvider;
    telemetry.traceProvider = traceProvider;
    telemetry.tracer = trace.getTracer(SERVICE_NAME);
    const meter = metrics.getMeter(SERVICE_NAME);
    telemetry.uiInteractions = meter.createCounter('yaoainote.client.interactions');
    telemetry.requestDuration = meter.createHistogram('yaoainote.client.request.duration', {
      unit: 'ms',
    });

    observeWebVitals();
    return true;
  } catch {
    // Keep the product functional if the optional telemetry configuration is invalid.
    return false;
  }
}

export function startSpan(name, attributes = {}, parentOperation, kind = SpanKind.INTERNAL) {
  const parentSpan = operationSpan(parentOperation);
  const parentContext = parentSpan
    ? trace.setSpan(context.active(), parentSpan)
    : context.active();
  const span = telemetry.tracer.startSpan(name, { kind }, parentContext);
  setAttributes(span, attributes);
  return { span, startedAt: now(), ended: false };
}

export function endSpan(operation, { attributes = {}, errorType } = {}) {
  if (!operation || operation.ended) return;

  setAttributes(operation.span, attributes);
  if (errorType) {
    operation.span.setAttribute('error.type', errorType);
    operation.span.setStatus({ code: SpanStatusCode.ERROR });
  }
  operation.span.end();
  operation.ended = true;
}

export function startUiOperation(name, operation, attributes = {}, parentOperation) {
  return {
    ...startSpan(name, { 'ui.operation': operation, ...attributes }, parentOperation),
    operation,
  };
}

export function endUiOperation(operation, {
  attributes = {},
  errorType,
  outcome = 'success',
  statusCode,
} = {}) {
  if (!operation || operation.ended) return;

  const safeOutcome = normalizedOutcome(outcome);
  const spanAttributes = {
    ...attributes,
    'ui.result': outcomeToUiResult(safeOutcome),
  };
  if (Number.isInteger(statusCode)) spanAttributes['http.response.status_code'] = statusCode;
  endSpan(operation, {
    attributes: spanAttributes,
    errorType: safeOutcome === 'cancelled' ? undefined : errorType,
  });
  telemetry.uiInteractions?.add(1, {
    operation: operation.operation,
    outcome: safeOutcome,
  });
}

export function startClientRequest(route, method, parentOperation) {
  return {
    ...startSpan('http.client.request', {
      'http.request.method': method,
      'http.route': route,
    }, parentOperation, SpanKind.CLIENT),
    method,
    route,
  };
}

export function endClientRequest(request, {
  errorType,
  outcome = 'success',
  statusCode,
} = {}) {
  if (!request || request.ended) return;

  const safeOutcome = normalizedOutcome(outcome);
  const attributes = {};
  if (Number.isInteger(statusCode)) attributes['http.response.status_code'] = statusCode;
  endSpan(request, {
    attributes,
    errorType: safeOutcome === 'success' || safeOutcome === 'cancelled' ? undefined : errorType,
  });
  telemetry.requestDuration?.record(now() - request.startedAt, {
    route: request.route,
    method: request.method,
    outcome: safeOutcome,
  });
}

export function failureTelemetry(error) {
  if (error?.name === 'AbortError') {
    return { errorType: 'RequestCancelled', outcome: 'cancelled', statusCode: undefined };
  }

  const statusCode = Number.isInteger(error?.status) ? error.status : undefined;
  if (statusCode >= 500) {
    return { errorType: 'HttpServerError', outcome: 'server_error', statusCode };
  }
  if (statusCode >= 400) {
    return { errorType: 'HttpClientError', outcome: 'client_error', statusCode };
  }
  return { errorType: 'NetworkError', outcome: 'dependency_error', statusCode };
}

function propagationAllowed(target) {
  try {
    const targetUrl = new URL(target, window.location.origin);
    if (targetUrl.origin === window.location.origin) return true;
    const allowedOrigins = (import.meta.env.VITE_OTEL_PROPAGATION_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean);
    return allowedOrigins.includes(targetUrl.origin);
  } catch {
    return false;
  }
}

export function traceHeaders(operation, target) {
  if (!telemetry.enabled || !propagationAllowed(target)) return {};

  const spanContext = operationSpan(operation)?.spanContext?.();
  if (!spanContext || !isSpanContextValid(spanContext)) return {};

  const flags = (spanContext.traceFlags & 1) === 1 ? '01' : '00';
  return {
    traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`,
  };
}

export function startInitialRender() {
  return startSpan('ui.render.initial', {
    'ui.lifecycle': 'initial',
    'ui.operation': 'render',
  });
}

export function endInitialRender(render) {
  endSpan(render);
}
