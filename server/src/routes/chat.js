import { Router } from 'express';
import { embedQuery } from '../lib/embed.js';
import { queryByVector } from '../lib/pinecone.js';
import { answerQuestion } from '../lib/claude.js';

const router = Router();

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 20;

router.post('/', async (req, res, next) => {
  try {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) {
      return res.status(400).json({ error: 'query is required (non-empty string)' });
    }

    const requestedTopK = Number(req.body?.topK);
    const topK = Number.isFinite(requestedTopK) && requestedTopK > 0
      ? Math.min(Math.floor(requestedTopK), MAX_TOP_K)
      : DEFAULT_TOP_K;

    const queryVector = await embedQuery(query);
    const chunks = await queryByVector(queryVector, topK);

    const { answer, usage, stopReason } = await answerQuestion({ query, chunks });

    res.json({
      query,
      answer,
      stopReason,
      sources: chunks.map((c) => ({
        documentId: c.documentId,
        documentName: c.documentName,
        chunkIndex: c.chunkIndex,
        score: c.score,
        text: c.text,
      })),
      usage,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
