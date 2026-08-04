import { Router } from 'express';
import { embedQuery } from '../lib/embed.js';
import { queryByVector } from '../lib/pinecone.js';
import {
  getClient,
  buildAnswerParams,
  NO_CONTEXT_FALLBACK,
  MODEL,
} from '../lib/claude.js';
import {
  annotateRoute,
  createHttpError,
  downstreamHeaders,
  instrumentStage,
  markRequestCancelled,
  markRequestError,
  recordRag,
  recordRetrievedChunks,
  recordSseEvent,
  recordStream,
  recordTokens,
  startStage,
} from '../lib/observability.js';

const router = Router();

const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 20;
const MAX_TOKENS = 16000;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FEEDBACK_REASON_CODES = new Set([
  'useful',
  'not_useful_incorrect',
  'not_useful_incomplete',
  'not_useful_irrelevant',
  'not_useful_other',
]);

// Emit a single SSE event with a JSON payload, returning only its wire size.
function sse(res, payload) {
  const encoded = `data: ${JSON.stringify(payload)}\n\n`;
  res.write(encoded);
  return Buffer.byteLength(encoded);
}

function sseDone(res) {
  const encoded = 'data: [DONE]\n\n';
  res.write(encoded);
  res.end();
  return Buffer.byteLength(encoded);
}

function safeStopReason(reason) {
  const allowed = new Set([
    'end_turn',
    'max_tokens',
    'stop_sequence',
    'tool_use',
    'pause_turn',
    'refusal',
    'no_context',
    'cancelled',
    'error',
  ]);
  return allowed.has(reason) ? reason : 'unknown';
}

async function emitResponseEvent(res, payload, eventType, stopReason) {
  const payloadBytes = await instrumentStage(
    {
      name: 'sse.response.emit',
      event: 'sse.response.emit',
      message: 'SSE response emitted',
      errorCode: 'SSE_RESPONSE_WRITE_FAILED',
      attributes: {
        'sse.event_type': eventType,
        'sse.event_count': 1,
      },
    },
    async (stage) => {
      const bytes = sse(res, payload);
      stage.setAttributes({
        'sse.payload_bytes': bytes,
        'sse.stop_reason': stopReason,
      });
      return bytes;
    },
  );
  recordSseEvent(eventType, 'success');
  return payloadBytes;
}

async function emitDone(res, stopReason, usage) {
  return instrumentStage(
    {
      name: 'sse.response.emit',
      event: 'sse.response.emit',
      message: 'SSE response emitted',
      errorCode: 'SSE_RESPONSE_WRITE_FAILED',
      attributes: {
        'sse.event_type': 'done',
        'sse.event_count': 1,
        'sse.stop_reason': stopReason,
      },
    },
    async (stage) => {
      const bytes = sse(res, { type: 'done', stopReason, usage }) + sseDone(res);
      stage.setAttribute('sse.payload_bytes', bytes);
      return bytes;
    },
  ).then((bytes) => {
    recordSseEvent('done', 'success');
    return bytes;
  });
}

router.post('/feedback', async (req, res, next) => {
  annotateRoute(req, '/api/chat/feedback');
  const requestId = req.body?.requestId;
  const reasonCode = req.body?.reasonCode;

  try {
    await instrumentStage(
      {
        name: 'chat.feedback',
        event: 'chat.feedback',
        message: 'Chat feedback accepted',
        errorCode: 'FEEDBACK_INVALID',
        attributes: {},
      },
      async (stage) => {
        if (
          typeof requestId !== 'string'
          || !REQUEST_ID_PATTERN.test(requestId)
          || typeof reasonCode !== 'string'
          || !FEEDBACK_REASON_CODES.has(reasonCode)
        ) {
          stage.setAttribute('feedback.validation_result', 'rejected');
          throw createHttpError(
            400,
            'requestId and reasonCode are required',
            { type: 'ValidationError', code: 'FEEDBACK_INVALID' },
          );
        }

        // requestId is only validated to match the client contract; do not retain
        // or emit it because correlation IDs are excluded from normal telemetry.
        stage.setAttributes({
          'feedback.reason_code': reasonCode,
          'feedback.validation_result': 'accepted',
        });
        res.status(204).end();
      },
    );
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res) => {
  annotateRoute(req, '/api/chat');
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  const queryChars = query.length;
  const requestedTopK = Number(req.body?.topK);
  const topK = Number.isFinite(requestedTopK) && requestedTopK > 0
    ? Math.min(Math.floor(requestedTopK), MAX_TOP_K)
    : DEFAULT_TOP_K;

  let aborted = false;
  let noContext = false;
  let retrievedCount = 0;
  let stopReason = 'unknown';

  try {
    await instrumentStage(
      {
        name: 'rag.chat',
        event: 'rag.chat',
        message: 'RAG chat completed',
        errorCode: 'RAG_CHAT_FAILED',
        attributes: {
          'rag.query_chars': queryChars,
          'rag.requested_top_k': topK,
          'rag.retrieved_count': 0,
          'rag.no_context': false,
          'rag.cancelled': false,
          'rag.validation_result': 'pending',
          'sse.stop_reason': 'unknown',
        },
        onComplete: ({ duration, outcome }) => {
          recordRag(duration, outcome, noContext);
          recordRetrievedChunks(retrievedCount, outcome);
        },
      },
      async (ragStage) => {
        if (!query) {
          ragStage.setAttribute('rag.validation_result', 'rejected');
          throw createHttpError(
            400,
            'query is required (non-empty string)',
            { type: 'ValidationError', code: 'QUERY_REQUIRED' },
          );
        }
        ragStage.setAttribute('rag.validation_result', 'accepted');

        // SSE headers. flushHeaders() makes the browser see them before the first byte
        // of body — important so it knows to start parsing event-stream now.
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (Nginx/Railway)
        res.flushHeaders();

        // If the client disconnects mid-stream we should stop work.
        req.on('close', () => { aborted = true; });

        const queryVector = await embedQuery(query);
        const chunks = await queryByVector(queryVector, topK);
        retrievedCount = chunks.length;
        ragStage.setAttribute('rag.retrieved_count', retrievedCount);

        const sources = chunks.map((chunk) => ({
          documentId: chunk.documentId,
          documentName: chunk.documentName,
          chunkIndex: chunk.chunkIndex,
          score: chunk.score,
          text: chunk.text,
        }));
        await instrumentStage(
          {
            name: 'sse.sources.emit',
            event: 'sse.sources.emit',
            message: 'SSE sources emitted',
            errorCode: 'SSE_SOURCES_WRITE_FAILED',
            attributes: {
              'rag.retrieved_count': retrievedCount,
              'sse.event_count': 1,
            },
          },
          async (sourceStage) => {
            sourceStage.setAttribute('sse.payload_bytes', sse(res, { type: 'sources', sources }));
          },
        );

        if (!chunks.length) {
          noContext = true;
          stopReason = 'no_context';
          ragStage.setAttributes({
            'rag.no_context': true,
            'sse.stop_reason': stopReason,
          });
          await emitResponseEvent(res, { type: 'text', text: NO_CONTEXT_FALLBACK }, 'text');
          await emitDone(res, stopReason, null);
          return;
        }

        const params = await instrumentStage(
          {
            name: 'rag.prompt.build',
            event: 'rag.prompt.build',
            message: 'RAG prompt build completed',
            errorCode: 'RAG_PROMPT_BUILD_FAILED',
            attributes: {
              'rag.retrieved_count': retrievedCount,
              'rag.context_chars': chunks.reduce((total, chunk) => total + (chunk.text?.length || 0), 0),
              'rag.context_chunk_count': retrievedCount,
              'gen_ai.request.model': MODEL,
              'gen_ai.request.max_tokens': MAX_TOKENS,
            },
          },
          async (promptStage) => {
            const built = buildAnswerParams({ query, chunks });
            promptStage.setAttribute('rag.prompt_chars', built.messages[0].content.length);
            return built;
          },
        );

        const final = await instrumentStage(
          {
            name: 'gen_ai.chat.stream',
            event: 'gen_ai.chat.stream',
            message: 'Claude stream completed',
            errorCode: 'ANTHROPIC_STREAM_FAILED',
            attributes: {
              'gen_ai.system': 'anthropic',
              'gen_ai.request.model': MODEL,
              'gen_ai.operation.name': 'chat',
              'gen_ai.request.max_tokens': MAX_TOKENS,
              'rag.prompt_chars': params.messages[0].content.length,
              'gen_ai.response.stop_reason': 'unknown',
              'sse.text_delta_count': 0,
              'sse.text_bytes': 0,
            },
            onComplete: ({ duration, outcome, summary }) => {
              recordStream(
                duration,
                MODEL,
                outcome,
                summary['gen_ai.response.stop_reason'],
              );
            },
          },
          async (streamStage) => {
            const textStage = startStage(
              {
                name: 'sse.response.emit',
                event: 'sse.response.emit',
                message: 'SSE text response emitted',
                errorCode: 'SSE_RESPONSE_WRITE_FAILED',
                attributes: {
                  'sse.event_type': 'text',
                  'sse.payload_bytes': 0,
                  'sse.event_count': 0,
                },
              },
            );
            let textDeltaCount = 0;
            let textBytes = 0;

            try {
              const stream = getClient().messages.stream(params, {
                headers: downstreamHeaders(),
              });

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
                  textStage.run(() => {
                    textBytes += sse(res, { type: 'text', text: event.delta.text });
                  });
                  textDeltaCount += 1;
                  recordSseEvent('text', 'success');
                }
              }

              textStage.setAttributes({
                'sse.payload_bytes': textBytes,
                'sse.text_delta_count': textDeltaCount,
                'sse.event_count': textDeltaCount,
              });
              streamStage.setAttributes({
                'sse.text_delta_count': textDeltaCount,
                'sse.text_bytes': textBytes,
              });

              if (aborted) {
                stopReason = 'cancelled';
                textStage.setOutcome('cancelled');
                textStage.complete();
                streamStage.setAttributes({
                  'gen_ai.response.stop_reason': stopReason,
                  'rag.cancelled': true,
                });
                streamStage.setOutcome('cancelled');
                return null;
              }

              const completed = await stream.finalMessage();
              stopReason = safeStopReason(completed.stop_reason);
              streamStage.setAttributes({
                'gen_ai.response.stop_reason': stopReason,
                'gen_ai.usage.input_tokens': completed.usage?.input_tokens,
                'gen_ai.usage.output_tokens': completed.usage?.output_tokens,
              });
              recordTokens(MODEL, completed.usage?.input_tokens, completed.usage?.output_tokens);
              textStage.complete();
              return completed;
            } catch (error) {
              streamStage.setAttribute('gen_ai.response.stop_reason', 'error');
              textStage.fail(error);
              throw error;
            }
          },
        );

        if (aborted) {
          ragStage.setAttributes({
            'rag.cancelled': true,
            'sse.stop_reason': 'cancelled',
          });
          ragStage.setOutcome('cancelled');
          markRequestCancelled(req);
          return;
        }

        ragStage.setAttribute('sse.stop_reason', stopReason);
        await emitDone(res, stopReason, final.usage);
      },
    );
  } catch (error) {
    markRequestError(req, error, 'RAG_CHAT_FAILED');
    if (!res.headersSent) {
      res.status(error.status || 500).json({ error: error.message || 'Server error' });
      return;
    }

    if (res.writableEnded) return;
    try {
      await emitResponseEvent(
        res,
        { type: 'error', message: error.message || 'Server error' },
        'error',
        'error',
      );
      await emitDone(res, 'error', null);
    } catch {
      // The stream was already closed by the client.
    }
  }
});

export default router;
