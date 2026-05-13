import { Router } from 'express';
import { embedQuery } from '../lib/embed.js';
import { queryByVector } from '../lib/pinecone.js';
import {
  getClient,
  buildAnswerParams,
  NO_CONTEXT_FALLBACK,
} from '../lib/claude.js';

const router = Router();

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 20;

// Emit a single SSE event with a JSON payload.
function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sseDone(res) {
  res.write('data: [DONE]\n\n');
  res.end();
}

router.post('/', async (req, res) => {
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  if (!query) {
    res.status(400).json({ error: 'query is required (non-empty string)' });
    return;
  }

  const requestedTopK = Number(req.body?.topK);
  const topK = Number.isFinite(requestedTopK) && requestedTopK > 0
    ? Math.min(Math.floor(requestedTopK), MAX_TOP_K)
    : DEFAULT_TOP_K;

  // SSE headers. flushHeaders() makes the browser see them before the first byte
  // of body — important so it knows to start parsing event-stream now.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (Nginx/Railway)
  res.flushHeaders();

  // If the client disconnects mid-stream we should stop work.
  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    // 1. Retrieve sources up front and emit them immediately so the UI can show
    //    citation chips while the answer is still streaming.
    const queryVector = await embedQuery(query);
    const chunks = await queryByVector(queryVector, topK);
    const sources = chunks.map((c) => ({
      documentId: c.documentId,
      documentName: c.documentName,
      chunkIndex: c.chunkIndex,
      score: c.score,
      text: c.text,
    }));
    sse(res, { type: 'sources', sources });

    // 2. If we have no chunks, emit a canned fallback and finish.
    if (!chunks.length) {
      sse(res, { type: 'text', text: NO_CONTEXT_FALLBACK });
      sse(res, { type: 'done', stopReason: 'no_context', usage: null });
      sseDone(res);
      return;
    }

    // 3. Stream Claude's answer token-by-token.
    const params = buildAnswerParams({ query, chunks });
    const stream = getClient().messages.stream(params);

    for await (const event of stream) {
      if (aborted) {
        stream.controller?.abort?.();
        break;
      }
      if (
        event.type === 'content_block_delta' &&
        event.delta?.type === 'text_delta' &&
        event.delta.text
      ) {
        sse(res, { type: 'text', text: event.delta.text });
      }
    }

    if (aborted) return;

    const final = await stream.finalMessage();
    sse(res, {
      type: 'done',
      stopReason: final.stop_reason,
      usage: final.usage,
    });
    sseDone(res);
  } catch (err) {
    console.error('chat stream error:', err);
    // We may or may not have written headers yet; SSE headers are set above so
    // we always have. Emit the error as an SSE event and close.
    try {
      sse(res, { type: 'error', message: err.message || 'Server error' });
      sseDone(res);
    } catch {
      // Connection probably already dead.
    }
  }
});

export default router;
