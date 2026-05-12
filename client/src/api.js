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
