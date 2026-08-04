import { Router } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { parseToText } from '../lib/parse.js';
import { chunkText } from '../lib/chunk.js';
import { embedDocuments } from '../lib/embed.js';
import { upsertChunks, deleteDocumentVectors } from '../lib/pinecone.js';
import { insertDocument, listDocuments, getDocument, deleteDocument } from '../lib/db.js';
import {
  annotateRoute,
  createHttpError,
  instrumentStage,
  recordChunks,
  recordDocumentOperation,
  recordParseDuration,
  recordUploadBytes,
  safeFileExtension,
  safeMimeFamily,
} from '../lib/observability.js';
import { CHUNK_OVERLAP_TOKENS, CHUNK_TARGET_TOKENS } from '../lib/chunk.js';

const router = Router();

// Keep uploads in memory — files are typically <50MB and we re-stream them
// straight into the parse pipeline.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

function runMiddleware(middleware, req, res) {
  return new Promise((resolve, reject) => {
    middleware(req, res, (error) => (error ? reject(error) : resolve()));
  });
}

router.get('/', async (req, res, next) => {
  annotateRoute(req, '/api/documents');
  try {
    await instrumentStage(
      {
        name: 'documents.list',
        event: 'documents.list',
        message: 'Document list completed',
        errorCode: 'SQLITE_DOCUMENT_LIST_FAILED',
        attributes: {},
        onComplete: ({ outcome }) => recordDocumentOperation('list', outcome),
      },
      async (stage) => {
        const documents = listDocuments();
        stage.setAttribute('documents.count', documents.length);
        res.json({ documents });
      },
    );
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  annotateRoute(req, '/api/documents');
  try {
    await instrumentStage(
      {
        name: 'documents.upload',
        event: 'documents.upload',
        message: 'Document upload completed',
        errorCode: 'DOCUMENT_UPLOAD_FAILED',
        attributes: {
          'upload.file_extension': 'other',
          'upload.bytes': 0,
          'document.text_chars': 0,
          'document.chunk_count': 0,
        },
        onComplete: ({ outcome, summary }) => {
          recordDocumentOperation('upload', outcome);
          recordUploadBytes(
            summary['upload.bytes'] || 0,
            summary['upload.file_extension'] || 'other',
            outcome,
          );
        },
      },
      async (uploadStage) => {
        try {
          await runMiddleware(upload.single('file'), req, res);
          if (!req.file) {
            throw createHttpError(
              400,
              'no file uploaded (form field "file")',
              { type: 'ValidationError', code: 'UPLOAD_FILE_MISSING' },
            );
          }

          const { buffer, originalname: name, size, mimetype } = req.file;
          const fileExtension = safeFileExtension(name);
          uploadStage.setAttributes({
            'upload.file_extension': fileExtension,
            'upload.mime_family': safeMimeFamily(mimetype),
            'upload.bytes': size,
            'upload.file_count': 1,
          });

          const text = await instrumentStage(
            {
              name: 'documents.parse',
              event: 'documents.parse',
              message: 'Document parse completed',
              errorCode: 'DOCUMENT_PARSE_FAILED',
              attributes: {
                'document.file_extension': fileExtension,
                'upload.bytes': size,
              },
              onComplete: ({ duration, outcome }) => recordParseDuration(duration, fileExtension, outcome),
            },
            async (parseStage) => {
              try {
                const parsed = await parseToText({ buffer, originalName: name });
                parseStage.setAttributes({
                  'document.text_chars': parsed.length,
                  'document.non_empty': Boolean(parsed.trim()),
                  'parser.result': 'success',
                });
                return parsed;
              } catch (error) {
                parseStage.setAttribute('parser.result', 'error');
                throw error;
              }
            },
          );
          uploadStage.setAttribute('document.text_chars', text.length);
          if (!text.trim()) {
            throw createHttpError(
              400,
              'document parsed to empty text',
              { type: 'ValidationError', code: 'DOCUMENT_EMPTY' },
            );
          }

          const chunks = await instrumentStage(
            {
              name: 'documents.chunk',
              event: 'documents.chunk',
              message: 'Document chunking completed',
              errorCode: 'DOCUMENT_CHUNKING_FAILED',
              attributes: {
                'document.text_chars': text.length,
                'chunk.target_tokens': CHUNK_TARGET_TOKENS,
                'chunk.overlap_tokens': CHUNK_OVERLAP_TOKENS,
              },
              onComplete: ({ outcome, summary }) => {
                if (outcome === 'success') {
                  recordChunks(summary['document.chunk_count'] || 0, fileExtension);
                }
              },
            },
            async (chunkStage) => {
              const produced = chunkText(text);
              const lengths = produced.map((chunk) => chunk.length);
              const totalChars = lengths.reduce((total, length) => total + length, 0);
              chunkStage.setAttributes({
                'document.chunk_count': produced.length,
                'chunk.total_chars': totalChars,
                'chunk.min_chars': lengths.length ? Math.min(...lengths) : 0,
                'chunk.max_chars': lengths.length ? Math.max(...lengths) : 0,
                'chunk.mean_chars': lengths.length ? Math.round(totalChars / lengths.length) : 0,
              });
              return produced;
            },
          );
          uploadStage.setAttribute('document.chunk_count', chunks.length);
          if (!chunks.length) {
            throw createHttpError(
              400,
              'no chunks produced from document',
              { type: 'ValidationError', code: 'DOCUMENT_CHUNKS_EMPTY' },
            );
          }

          const embeddings = await embedDocuments(chunks);

          const id = nanoid();
          await upsertChunks({
            documentId: id,
            documentName: name,
            chunks,
            embeddings,
          });

          const doc = {
            id,
            name,
            sizeBytes: size,
            chunkCount: chunks.length,
            createdAt: Date.now(),
          };
          await insertDocument(doc);

          uploadStage.setAttribute('documents.result', 'success');
          res.status(201).json(doc);
        } catch (error) {
          uploadStage.setAttribute('documents.result', 'error');
          throw error;
        }
      },
    );
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  annotateRoute(req, '/api/documents/:id');
  try {
    await instrumentStage(
      {
        name: 'documents.delete',
        event: 'documents.delete',
        message: 'Document delete completed',
        errorCode: 'DOCUMENT_DELETE_FAILED',
        attributes: {
          'document.chunk_count': 0,
        },
        onComplete: ({ outcome }) => recordDocumentOperation('delete', outcome),
      },
      async (deleteStage) => {
        try {
          const doc = getDocument(req.params.id);
          if (!doc) {
            throw createHttpError(
              404,
              'document not found',
              { type: 'ValidationError', code: 'DOCUMENT_NOT_FOUND' },
            );
          }

          deleteStage.setAttribute('document.chunk_count', doc.chunkCount);
          await deleteDocumentVectors({ documentId: doc.id, chunkCount: doc.chunkCount });
          await deleteDocument(doc.id);
          deleteStage.setAttribute('documents.result', 'success');
          res.json({ ok: true });
        } catch (error) {
          deleteStage.setAttribute('documents.result', 'error');
          throw error;
        }
      },
    );
  } catch (err) {
    next(err);
  }
});

export default router;
