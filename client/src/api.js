// Tiny fetch wrapper for the YaoAINote backend.
// In dev, Vite proxies /api → localhost:3000. In prod, we hit the absolute
// VITE_API_BASE_URL set in the Vercel project (e.g. the Railway URL).
const BASE = import.meta.env.VITE_API_BASE_URL || '';

const KEY_STORAGE = 'yaoainote.apiKey';

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

async function asJson(res) {
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body.error || JSON.stringify(body);
    } catch {
      detail = await res.text().catch(() => '');
    }
    const err = new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function listDocuments() {
  const res = await fetch(`${BASE}/api/documents`, { headers: { ...authHeaders() } });
  const json = await asJson(res);
  return json.documents;
}

export async function uploadDocument(file) {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}/api/documents`, {
    method: 'POST',
    headers: { ...authHeaders() }, // don't set content-type; browser sets multipart boundary
    body: form,
  });
  return asJson(res);
}

export async function deleteDocument(id) {
  const res = await fetch(`${BASE}/api/documents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { ...authHeaders() },
  });
  return asJson(res);
}

export async function ask(query) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ query }),
  });
  return asJson(res);
}

/**
 * Stream a chat response over SSE.
 * Calls onSources(sources[]), onText(deltaString), onDone({usage, stopReason}),
 * onError(Error) as events arrive. Returns when the stream ends.
 *
 * Server sends `data: {type: "sources"|"text"|"done"|"error", ...}\n\n` events
 * followed by a final `data: [DONE]\n\n`.
 */
export async function askStream(query, { onSources, onText, onDone, onError, signal } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ query }),
      signal,
    });
  } catch (err) {
    onError?.(err);
    return;
  }

  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      msg = body.error || msg;
    } catch {}
    onError?.(new Error(msg));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE events are separated by blank lines (\n\n).
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      // Each event may have multiple lines; we only care about `data:` lines.
      const dataLines = rawEvent
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart());
      if (!dataLines.length) continue;
      const payload = dataLines.join('\n');

      if (payload === '[DONE]') return;

      try {
        const evt = JSON.parse(payload);
        switch (evt.type) {
          case 'sources': onSources?.(evt.sources); break;
          case 'text': onText?.(evt.text); break;
          case 'done': onDone?.({ usage: evt.usage, stopReason: evt.stopReason }); break;
          case 'error': onError?.(new Error(evt.message)); break;
        }
      } catch {
        // Ignore malformed events.
      }
    }
  }
}
