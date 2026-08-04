import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { instrumentStage } from './observability.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In production (Railway) we mount a persistent volume and point DATA_DIR at it.
// In local dev DATA_DIR is unset and we use server/data/.
const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '../../data');
mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'yaoainote.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS documents (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );
`);

const insertStmt = db.prepare(
  `INSERT INTO documents (id, name, size_bytes, chunk_count, created_at)
   VALUES (@id, @name, @size_bytes, @chunk_count, @created_at)`,
);

const listStmt = db.prepare(
  `SELECT id, name, size_bytes AS sizeBytes, chunk_count AS chunkCount, created_at AS createdAt
   FROM documents ORDER BY created_at DESC`,
);

const getStmt = db.prepare(
  `SELECT id, name, size_bytes AS sizeBytes, chunk_count AS chunkCount, created_at AS createdAt
   FROM documents WHERE id = ?`,
);

const deleteStmt = db.prepare(`DELETE FROM documents WHERE id = ?`);

export async function insertDocument(doc) {
  return instrumentStage(
    {
      name: 'metadata.insert',
      event: 'metadata.insert',
      message: 'SQLite document insert completed',
      errorCode: 'SQLITE_METADATA_INSERT_FAILED',
      attributes: {
        'db.system': 'sqlite',
        'db.operation': 'insert',
        'document.size_bytes': doc.sizeBytes,
        'document.chunk_count': doc.chunkCount,
      },
    },
    async (stage) => {
      try {
        const result = insertStmt.run({
          id: doc.id,
          name: doc.name,
          size_bytes: doc.sizeBytes,
          chunk_count: doc.chunkCount,
          created_at: doc.createdAt,
        });
        stage.setAttribute('db.rows_affected', result.changes);
      } catch (error) {
        error.telemetryError ||= { type: 'DatabaseError', code: 'SQLITE_METADATA_INSERT_FAILED' };
        throw error;
      }
    },
  );
}

export function listDocuments() {
  return listStmt.all();
}

export function getDocument(id) {
  return getStmt.get(id);
}

export async function deleteDocument(id) {
  return instrumentStage(
    {
      name: 'metadata.delete',
      event: 'metadata.delete',
      message: 'SQLite document delete completed',
      errorCode: 'SQLITE_METADATA_DELETE_FAILED',
      attributes: {
        'db.system': 'sqlite',
        'db.operation': 'delete',
      },
    },
    async (stage) => {
      try {
        const result = deleteStmt.run(id);
        stage.setAttribute('db.rows_affected', result.changes);
      } catch (error) {
        error.telemetryError ||= { type: 'DatabaseError', code: 'SQLITE_METADATA_DELETE_FAILED' };
        throw error;
      }
    },
  );
}
