import { Pinecone } from '@pinecone-database/pinecone';
import { EMBED_DIM } from './embed.js';
import {
  downstreamHeaders,
  instrumentStage,
  recordVector,
  roundScore,
} from './observability.js';

let _client = null;
let _index = null;

function getClient() {
  if (_client) return _client;
  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey) {
    throw Object.assign(new Error('PINECONE_API_KEY is not set'), {
      telemetryError: { type: 'ConfigurationError', code: 'PINECONE_API_KEY_MISSING' },
    });
  }
  _client = new Pinecone({ apiKey });
  return _client;
}

function getIndex(additionalHeaders) {
  if (additionalHeaders) {
    return getClient().index(process.env.PINECONE_INDEX || 'yaoainote', undefined, additionalHeaders);
  }
  if (_index) return _index;
  const name = process.env.PINECONE_INDEX || 'yaoainote';
  _index = getClient().index(name);
  return _index;
}

/**
 * Upsert vectors for a document's chunks.
 * @param {object} args
 * @param {string} args.documentId
 * @param {string} args.documentName
 * @param {string[]} args.chunks
 * @param {number[][]} args.embeddings
 */
export async function upsertChunks({ documentId, documentName, chunks, embeddings }) {
  if (chunks.length !== embeddings.length) {
    throw new Error('chunks and embeddings length mismatch');
  }
  if (embeddings.length && embeddings[0].length !== EMBED_DIM) {
    throw new Error(
      `embedding dim ${embeddings[0].length} != index dim ${EMBED_DIM}; recreate the Pinecone index with dimension ${EMBED_DIM}`,
    );
  }

  const createdAt = Date.now();
  const vectors = chunks.map((text, i) => ({
    id: `${documentId}#${i}`,
    values: embeddings[i],
    metadata: {
      documentId,
      documentName,
      chunkIndex: i,
      text,
      createdAt,
    },
  }));

  // Pinecone recommends batches of <=100 for upsert.
  const BATCH = 100;
  const batchCount = Math.ceil(vectors.length / BATCH);
  for (let i = 0; i < vectors.length; i += BATCH) {
    const batch = vectors.slice(i, i + BATCH);
    await instrumentStage(
      {
        name: 'vector_db.upsert',
        event: 'vector_db.upsert',
        message: 'Pinecone vector upsert completed',
        errorCode: 'PINECONE_UPSERT_FAILED',
        attributes: {
          'db.system': 'pinecone',
          'db.operation': 'upsert',
          'vector.count': batch.length,
          'vector.batch_count': batchCount,
          'embedding.vector_dimension': EMBED_DIM,
        },
        onComplete: ({ duration, outcome }) => recordVector(duration, 'upsert', outcome, batch.length),
      },
      async (stage) => {
        try {
          await getIndex(downstreamHeaders()).upsert(batch);
          stage.setAttribute('provider.status', 'success');
        } catch (error) {
          stage.setAttribute('provider.status', 'error');
          throw error;
        }
      },
    );
  }
}

export async function queryByVector(vector, topK = 8) {
  return instrumentStage(
    {
      name: 'vector_db.query',
      event: 'vector_db.query',
      message: 'Pinecone vector query completed',
      errorCode: 'PINECONE_QUERY_FAILED',
      attributes: {
        'db.system': 'pinecone',
        'db.operation': 'query',
        'vector.top_k': topK,
        'embedding.vector_dimension': EMBED_DIM,
      },
      onComplete: ({ duration, outcome, summary }) => {
        recordVector(duration, 'query', outcome, summary['vector.result_count'] || 0);
      },
    },
    async (stage) => {
      let result;
      try {
        result = await getIndex(downstreamHeaders()).query({
          vector,
          topK,
          includeMetadata: true,
        });
        stage.setAttribute('provider.status', 'success');
      } catch (error) {
        stage.setAttribute('provider.status', 'error');
        throw error;
      }
      const matches = result.matches || [];
      const scores = matches.map((match) => match.score).filter(Number.isFinite);
      stage.setAttributes({
        'vector.result_count': matches.length,
        'vector.score_max': scores.length ? roundScore(Math.max(...scores)) : undefined,
        'vector.score_min': scores.length ? roundScore(Math.min(...scores)) : undefined,
      });

      return matches.map((m) => ({
        id: m.id,
        score: m.score,
        documentId: m.metadata?.documentId,
        documentName: m.metadata?.documentName,
        chunkIndex: m.metadata?.chunkIndex,
        text: m.metadata?.text,
      }));
    },
  );
}

/**
 * Delete all vectors for a documentId. We use a deterministic id scheme
 * (`${documentId}#${i}`), so we ask SQLite for the chunkCount and delete by id —
 * works on both serverless (no metadata-filter delete) and pod-based indexes.
 */
export async function deleteDocumentVectors({ documentId, chunkCount }) {
  const ids = Array.from({ length: chunkCount }, (_, i) => `${documentId}#${i}`);
  if (!ids.length) return;
  const BATCH = 1000;
  const batchCount = Math.ceil(ids.length / BATCH);
  for (let i = 0; i < ids.length; i += BATCH) {
    const batch = ids.slice(i, i + BATCH);
    await instrumentStage(
      {
        name: 'vector_db.delete',
        event: 'vector_db.delete',
        message: 'Pinecone vector delete completed',
        errorCode: 'PINECONE_DELETE_FAILED',
        attributes: {
          'db.system': 'pinecone',
          'db.operation': 'delete',
          'vector.count': batch.length,
          'vector.batch_count': batchCount,
        },
        onComplete: ({ duration, outcome }) => recordVector(duration, 'delete', outcome, batch.length),
      },
      async (stage) => {
        try {
          await getIndex(downstreamHeaders()).deleteMany(batch);
          stage.setAttribute('provider.status', 'success');
        } catch (error) {
          stage.setAttribute('provider.status', 'error');
          throw error;
        }
      },
    );
  }
}
