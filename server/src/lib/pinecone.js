import { Pinecone } from '@pinecone-database/pinecone';
import { EMBED_DIM } from './embed.js';

let _client = null;
let _index = null;

function getClient() {
  if (_client) return _client;
  const apiKey = process.env.PINECONE_API_KEY;
  if (!apiKey) throw new Error('PINECONE_API_KEY is not set');
  _client = new Pinecone({ apiKey });
  return _client;
}

function getIndex() {
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
  const index = getIndex();
  const BATCH = 100;
  for (let i = 0; i < vectors.length; i += BATCH) {
    await index.upsert(vectors.slice(i, i + BATCH));
  }
}

export async function queryByVector(vector, topK = 8) {
  const index = getIndex();
  const result = await index.query({ vector, topK, includeMetadata: true });
  return (result.matches || []).map((m) => ({
    id: m.id,
    score: m.score,
    documentId: m.metadata?.documentId,
    documentName: m.metadata?.documentName,
    chunkIndex: m.metadata?.chunkIndex,
    text: m.metadata?.text,
  }));
}

/**
 * Delete all vectors for a documentId. We use a deterministic id scheme
 * (`${documentId}#${i}`), so we ask SQLite for the chunkCount and delete by id —
 * works on both serverless (no metadata-filter delete) and pod-based indexes.
 */
export async function deleteDocumentVectors({ documentId, chunkCount }) {
  const index = getIndex();
  const ids = Array.from({ length: chunkCount }, (_, i) => `${documentId}#${i}`);
  if (!ids.length) return;
  const BATCH = 1000;
  for (let i = 0; i < ids.length; i += BATCH) {
    await index.deleteMany(ids.slice(i, i + BATCH));
  }
}
