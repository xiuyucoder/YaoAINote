/**
 * Voyage AI embeddings client.
 * https://docs.voyageai.com/reference/embeddings-api
 *
 * Using `voyage-3-large` (1024 dims) — Anthropic's recommended pair for Claude.
 * Use `input_type: "document"` for indexing, `"query"` for searches.
 */
import {
  downstreamHeaders,
  instrumentStage,
  recordEmbedding,
} from './observability.js';

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const MODEL = 'voyage-3-large';
const BATCH_SIZE = 128; // Voyage allows up to 1000 inputs/request, 128 is plenty

async function embedBatch(texts, inputType, batchIndex, batchCount) {
  return instrumentStage(
    {
      name: 'embeddings.batch',
      event: 'embeddings.batch',
      message: 'Embedding batch completed',
      errorCode: 'VOYAGE_EMBEDDINGS_FAILED',
      attributes: {
        'gen_ai.system': 'voyage',
        'gen_ai.request.model': MODEL,
        'embedding.input_type': inputType,
        'embedding.batch_index': batchIndex,
        'embedding.batch_size': texts.length,
        'embedding.batch_count': batchCount,
        'embedding.input_chars': texts.reduce((total, text) => total + text.length, 0),
        'embedding.vector_dimension': EMBED_DIM,
      },
    },
    async (stage) => {
      const apiKey = process.env.VOYAGE_API_KEY;
      if (!apiKey) {
        throw Object.assign(new Error('VOYAGE_API_KEY is not set'), {
          telemetryError: { type: 'ConfigurationError', code: 'VOYAGE_API_KEY_MISSING' },
        });
      }

      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
          ...downstreamHeaders(),
        },
        body: JSON.stringify({ input: texts, model: MODEL, input_type: inputType }),
      });
      stage.setAttribute('http.response.status_code', res.status);

      if (!res.ok) {
        stage.setAttribute('provider.status', 'error');
        const body = await res.text().catch(() => '');
        throw Object.assign(new Error(`voyage embeddings failed: ${res.status} ${body}`), {
          telemetryError: { type: 'DependencyError', code: 'VOYAGE_EMBEDDINGS_FAILED' },
        });
      }

      const json = await res.json();
      stage.setAttribute('provider.status', 'success');
      // Sort by index to be safe — keep order aligned with input.
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  );
}

export async function embedDocuments(texts) {
  if (!texts.length) return [];
  const batchCount = Math.ceil(texts.length / BATCH_SIZE);
  return instrumentStage(
    {
      name: 'embeddings.documents',
      event: 'embeddings.documents',
      message: 'Document embeddings completed',
      errorCode: 'VOYAGE_DOCUMENT_EMBEDDING_FAILED',
      attributes: {
        'gen_ai.system': 'voyage',
        'gen_ai.request.model': MODEL,
        'embedding.input_type': 'document',
        'embedding.chunk_count': texts.length,
        'embedding.batch_count': batchCount,
        'embedding.input_chars': texts.reduce((total, text) => total + text.length, 0),
        'embedding.vector_dimension': EMBED_DIM,
      },
      onComplete: ({ duration, outcome }) => recordEmbedding(duration, 'document', outcome, texts.length),
    },
    async () => {
      const out = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const vectors = await embedBatch(batch, 'document', i / BATCH_SIZE, batchCount);
        out.push(...vectors);
      }
      return out;
    },
  );
}

export async function embedQuery(text) {
  return instrumentStage(
    {
      name: 'embeddings.query',
      event: 'embeddings.query',
      message: 'Query embedding completed',
      errorCode: 'VOYAGE_QUERY_EMBEDDING_FAILED',
      attributes: {
        'gen_ai.system': 'voyage',
        'gen_ai.request.model': MODEL,
        'embedding.input_type': 'query',
        'embedding.input_chars': text.length,
        'embedding.vector_dimension': EMBED_DIM,
      },
      onComplete: ({ duration, outcome }) => recordEmbedding(duration, 'query', outcome, 1),
    },
    async () => {
      const [vector] = await embedBatch([text], 'query', 0, 1);
      return vector;
    },
  );
}

export const EMBED_MODEL = MODEL;
export const EMBED_DIM = 1024;
