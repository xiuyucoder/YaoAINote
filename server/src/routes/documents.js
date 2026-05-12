import { Router } from 'express';
import multer from 'multer';
import { nanoid } from 'nanoid';
import { parseToText } from '../lib/parse.js';
import { chunkText } from '../lib/chunk.js';
import { embedDocuments } from '../lib/embed.js';
import { upsertChunks, deleteDocumentVectors } from '../lib/pinecone.js';
import { insertDocument, listDocuments, getDocument, deleteDocument } from '../lib/db.js';

const router = Router();

// Keep uploads in memory — files are typically <50MB and we re-stream them
// straight into the parse pipeline.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

router.get('/', (_req, res) => {
  res.json({ documents: listDocuments() });
});

router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'no file uploaded (form field "file")' });
    }

    const { buffer, originalname: name, size } = req.file;

    const text = await parseToText({ buffer, originalName: name });
    if (!text.trim()) {
      return res.status(400).json({ error: 'document parsed to empty text' });
    }

    const chunks = chunkText(text);
    if (!chunks.length) {
      return res.status(400).json({ error: 'no chunks produced from document' });
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
    insertDocument(doc);

    res.status(201).json(doc);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    const doc = getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: 'document not found' });

    await deleteDocumentVectors({ documentId: doc.id, chunkCount: doc.chunkCount });
    deleteDocument(doc.id);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
