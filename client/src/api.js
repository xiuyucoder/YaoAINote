// Tiny fetch wrapper for the YaoAINote backend.
// In dev, Vite proxies /api → localhost:3000. In prod, VITE_API_BASE_URL
// points to the deployed API.
import {
  endClientRequest,
  endSpan,
  endUiOperation,
  startClientRequest,
  startSpan,
  startUiOperation,
  traceHeaders,
} from './observability.js';

const BASE = import.meta.env.VITE_API_BASE_URL || '';
const KEY_STORAGE = 'yaoainote.apiKey';
const CHAT_TOP_K = 8;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STOP_REASONS = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'no_context',
  'cancelled',
  'error',
]);

export const FEEDBACK_REASON_CODES = Object.freeze({
  USEFUL: 'useful',
  INCORRECT: 'not_useful_incorrect',
  INCOMPLETE: 'not_useful_incomplete',
  IRRELEVANT: 'not_useful_irrelevant',
  OTHER: 'not_useful_other',
});

const FEEDBACK_REASONS = new Set(Object.values(FEEDBACK_REASON_CODES));

export function getApiKey() {
  return localStorage.getItem(KEY_STORAGE) || '';
}

export function setApiKey(key) {
  if (key) localStorage.setItem(KEY_STORAGE, key);
  else localStorage.removeItem(KEY_STORAGE);
}

function authHeaders() {
  const key = getApiKey();
  return key ? { 'x-api-key': key } : {};
}

function statusOutcome(status) {
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'client_error';
  return 'success';
}

function requestOutcome(error, status) {
  if (error?.name === 'AbortError') return 'cancelled';
  return Number.isInteger(status) && status >= 400
    ? statusOutcome(status)
    : 'dependency_error';
}

function requestErrorType(outcome, error) {
  if (error?.telemetryType) return error.telemetryType;
  if (outcome === 'client_error') return 'HttpClientError';
  if (outcome === 'server_error') return 'HttpServerError';
  if (outcome === 'cancelled') return 'RequestCancelled';
  return 'NetworkError';
}

function responseRequestId(response) {
  const requestId = response.headers.get('x-request-id');
  return requestId && REQUEST_ID_PATTERN.test(requestId) ? requestId : null;
}

async function asJson(response) {
  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body.error || JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => '');
    }
    const error = new Error(
      `${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`,
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function fetchJson(route, url, options = {}, parentOperation) {
  const method = options.method || 'GET';
  const request = startClientRequest(route, method, parentOperation);
  let statusCode;

  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        ...traceHeaders(request, url),
      },
    });
    statusCode = response.status;
    if (response.status === 204) {
      endClientRequest(request, { outcome: 'success', statusCode });
      return null;
    }
    const json = await asJson(response);
    endClientRequest(request, { outcome: 'success', statusCode });
    return json;
  } catch (error) {
    const outcome = requestOutcome(error, statusCode);
    endClientRequest(request, {
      errorType: requestErrorType(outcome, error),
      outcome,
      statusCode,
    });
    throw error;
  }
}

export async function listDocuments({ parentOperation } = {}) {
  const json = await fetchJson(
    '/api/documents',
    `${BASE}/api/documents`,
    { headers: authHeaders() },
    parentOperation,
  );
  return json.documents;
}

export async function uploadDocument(file, { parentOperation } = {}) {
  const form = new FormData();
  form.append('file', file);
  return fetchJson(
    '/api/documents',
    `${BASE}/api/documents`,
    {
      method: 'POST',
      headers: authHeaders(), // The browser adds the multipart boundary.
      body: form,
    },
    parentOperation,
  );
}

export async function deleteDocument(id, { parentOperation } = {}) {
  return fetchJson(
    '/api/documents/:id',
    `${BASE}/api/documents/${encodeURIComponent(id)}`,
    {
      method: 'DELETE',
      headers: authHeaders(),
    },
    parentOperation,
  );
}

export async function ask(query) {
  const submit = startUiOperation('ui.chat.submit', 'ask', {
    'rag.query_chars': query.length,
    'rag.requested_top_k': CHAT_TOP_K,
  });

  try {
    const json = await fetchJson(
      '/api/chat',
      `${BASE}/api/chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ query }),
      },
      submit,
    );
    endUiOperation(submit, { outcome: 'success' });
    return json;
  } catch (error) {
    const outcome = requestOutcome(error, error.status);
    endUiOperation(submit, {
      errorType: requestErrorType(outcome, error),
      outcome,
      statusCode: error.status,
    });
    throw error;
  }
}

/**
 * Calls onStarted({requestId}), onSources(sources[]), onText(deltaString),
 * onDone({usage, stopReason}), and onError(Error) as stream events arrive.
 */
export async function askStream(
  query,
  { onStarted, onSources, onText, onDone, onError, signal } = {},
) {
  const submit = startUiOperation('ui.chat.submit', 'ask', {
    'rag.query_chars': query.length,
    'rag.requested_top_k': CHAT_TOP_K,
  });
  const request = startClientRequest('/api/chat', 'POST', submit);
  const connect = startSpan('ui.chat.stream.connect', { 'sse.phase': 'connect' }, request);
  let stream;
  let sourcesPhase;
  let firstTextPhase;
  let statusCode;
  let eventCount = 0;
  let textDeltaCount = 0;
  let textBytes = 0;
  let stopReason = 'unknown';
  let doneReceived = false;

  try {
    const url = `${BASE}/api/chat`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(),
        ...traceHeaders(request, url),
      },
      body: JSON.stringify({ query }),
      signal,
    });
    statusCode = response.status;

    if (!response.ok) await asJson(response);

    endSpan(connect);
    stream = startSpan('ui.chat.stream', {}, request);
    sourcesPhase = startSpan('ui.chat.stream.sources', { 'sse.phase': 'sources' }, stream);
    firstTextPhase = startSpan('ui.chat.stream.first_text', { 'sse.phase': 'first_text' }, stream);
    onStarted?.({ requestId: responseRequestId(response) });

    if (!response.body) {
      const error = new Error('Streaming response is unavailable.');
      error.telemetryType = 'StreamUnavailable';
      throw error;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamEnded = false;

    while (!streamEnded) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let separator;
      while ((separator = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const dataLines = rawEvent
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart());
        if (!dataLines.length) continue;
        const payload = dataLines.join('\n');

        if (payload === '[DONE]') {
          streamEnded = true;
          break;
        }

        try {
          const event = JSON.parse(payload);
          if (!['sources', 'text', 'done', 'error'].includes(event.type)) continue;
          eventCount += 1;

          switch (event.type) {
            case 'sources':
              endSpan(sourcesPhase);
              sourcesPhase = null;
              onSources?.(event.sources);
              break;
            case 'text':
              endSpan(firstTextPhase);
              firstTextPhase = null;
              textDeltaCount += 1;
              textBytes += new TextEncoder().encode(event.text || '').byteLength;
              onText?.(event.text);
              break;
            case 'done':
              doneReceived = true;
              stopReason = STOP_REASONS.has(event.stopReason) ? event.stopReason : 'unknown';
              onDone?.({ usage: event.usage, stopReason: event.stopReason });
              break;
            case 'error': {
              const error = new Error(event.message || 'Chat stream failed.');
              error.telemetryType = 'SseError';
              throw error;
            }
          }
        } catch (error) {
          if (error?.telemetryType === 'SseError') throw error;
          // Ignore malformed SSE events without recording their payloads.
        }
      }
    }

    if (!doneReceived) {
      const error = new Error('The response stream ended before completion.');
      error.telemetryType = 'StreamIncomplete';
      throw error;
    }

    endSpan(sourcesPhase, { attributes: { 'sse.phase_result': 'not_received' } });
    endSpan(firstTextPhase, { attributes: { 'sse.phase_result': 'not_received' } });
    endSpan(stream, {
      attributes: {
        'rag.cancelled': false,
        'sse.event_count': eventCount,
        'sse.stop_reason': stopReason,
        'sse.text_bytes': textBytes,
        'sse.text_delta_count': textDeltaCount,
      },
    });
    endClientRequest(request, { outcome: 'success', statusCode });
    endUiOperation(submit, { outcome: 'success', statusCode });
  } catch (error) {
    const outcome = requestOutcome(error, statusCode);
    const errorType = requestErrorType(outcome, error);
    endSpan(connect, { errorType });
    endSpan(sourcesPhase, { attributes: { 'sse.phase_result': 'not_completed' }, errorType });
    endSpan(firstTextPhase, { attributes: { 'sse.phase_result': 'not_completed' }, errorType });
    endSpan(stream, {
      attributes: {
        'rag.cancelled': outcome === 'cancelled',
        'sse.event_count': eventCount,
        'sse.stop_reason': outcome === 'cancelled' ? 'cancelled' : 'error',
        'sse.text_bytes': textBytes,
        'sse.text_delta_count': textDeltaCount,
      },
      errorType: outcome === 'cancelled' ? undefined : errorType,
    });
    endClientRequest(request, { errorType, outcome, statusCode });
    endUiOperation(submit, { errorType, outcome, statusCode });
    onError?.(error);
  }
}

export async function submitAnswerFeedback(requestId, reasonCode) {
  if (!REQUEST_ID_PATTERN.test(requestId) || !FEEDBACK_REASONS.has(reasonCode)) {
    throw new Error('Invalid feedback.');
  }

  const feedback = startUiOperation('ui.chat.feedback', 'feedback', {
    'feedback.reason_code': reasonCode,
  });

  try {
    await fetchJson(
      '/api/chat/feedback',
      `${BASE}/api/chat/feedback`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ requestId, reasonCode }),
      },
      feedback,
    );
    endUiOperation(feedback, { outcome: 'success' });
  } catch (error) {
    const outcome = requestOutcome(error, error.status);
    endUiOperation(feedback, {
      errorType: requestErrorType(outcome, error),
      outcome,
      statusCode: error.status,
    });
    throw error;
  }
}
