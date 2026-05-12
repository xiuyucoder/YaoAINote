/**
 * Voyage AI embeddings client.
 * https://docs.voyageai.com/reference/embeddings-api
 *
 * Using `voyage-3-large` (1024 dims) — Anthropic's recommended pair for Claude.
 * Use `input_type: "document"` for indexing, `"query"` for searches.
 */
const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3-large';
const BATCH_SIZE = 128; // Voyage allows up to 1000 inputs/request, 128 is plenty

async function embedBatch(texts, inputType) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY is not set');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ input: texts, model: MODEL, input_type: inputType }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`voyage embeddings failed: ${res.status} ${body}`);
  }

  const json = await res.json();
  // Sort by index to be safe — keep order aligned with input.
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

export async function embedDocuments(texts) {
  if (!texts.length) return [];
  const out = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const vectors = await embedBatch(batch, 'document');
    out.push(...vectors);
  }
  return out;
}

export async function embedQuery(text) {
  const [vector] = await embedBatch([text], 'query');
  return vector;
}

export const EMBED_MODEL = MODEL;
export const EMBED_DIM = 1024;
