import { Router } from 'express';
import { embedQuery } from '../lib/embed.js';
import { queryByVector } from '../lib/pinecone.js';
import { getClient, buildAnswerParams, NO_CONTEXT_FALLBACK, MODEL } from '../lib/claude.js';
import { providerFailureAttributes } from '../lib/llm-diagnostics.js';
import { beginSse, endSse, isLlmStreamingEnabled, writeSseEvent } from '../lib/chat-streaming.js';
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

function clientErrorMessage(error) {
  if (
    Number(error?.status) >= 400 &&
    Number(error?.status) < 500 &&
    error?.telemetryError?.type === 'ValidationError'
  ) {
    return error.message || 'Invalid chat request.';
  }
  return 'Chat request failed. Check the server logs using the request ID.';
}

function emitSse(res, event) {
  const emitted = writeSseEvent(res, event);
  if (emitted) recordSseEvent(event.type, 'success');
  return emitted;
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
          typeof requestId !== 'string' ||
          !REQUEST_ID_PATTERN.test(requestId) ||
          typeof reasonCode !== 'string' ||
          !FEEDBACK_REASON_CODES.has(reasonCode)
        ) {
          stage.setAttribute('feedback.validation_result', 'rejected');
          throw createHttpError(400, 'requestId and reasonCode are required', {
            type: 'ValidationError',
            code: 'FEEDBACK_INVALID',
          });
        }

        // requestId is only validated to match the client contract; do not retain
        // or emit it because correlation IDs are excluded from normal telemetry.
        stage.setAttributes({
          'feedback.reason_code': reasonCode,
          'feedback.validation_result': 'accepted',
        });
        res.status(204).end();
      }
    );
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res) => {
  annotateRoute(req, '/api/chat');
  const streaming = isLlmStreamingEnabled();
  const query = typeof req.body?.query === 'string' ? req.body.query.trim() : '';
  const queryChars = query.length;
  const requestedTopK = Number(req.body?.topK);
  const topK =
    Number.isFinite(requestedTopK) && requestedTopK > 0
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
          'gen_ai.response.stop_reason': 'unknown',
        },
        onComplete: ({ duration, outcome }) => {
          recordRag(duration, outcome, noContext);
          recordRetrievedChunks(retrievedCount, outcome);
        },
      },
      async (ragStage) => {
        if (!query) {
          ragStage.setAttribute('rag.validation_result', 'rejected');
          throw createHttpError(400, 'query is required (non-empty string)', {
            type: 'ValidationError',
            code: 'QUERY_REQUIRED',
          });
        }
        ragStage.setAttribute('rag.validation_result', 'accepted');

        req.on('aborted', () => {
          aborted = true;
        });

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
        if (!chunks.length) {
          noContext = true;
          stopReason = 'no_context';
          ragStage.setAttributes({
            'rag.no_context': true,
            'gen_ai.response.stop_reason': stopReason,
          });
          if (streaming) {
            beginSse(res);
            emitSse(res, { type: 'sources', sources });
            emitSse(res, { type: 'text', text: NO_CONTEXT_FALLBACK });
            emitSse(res, { type: 'done', usage: null, stopReason });
            endSse(res);
          } else {
            res.json({
              answer: NO_CONTEXT_FALLBACK,
              sources,
              usage: null,
              stopReason,
            });
          }
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
              'rag.context_chars': chunks.reduce(
                (total, chunk) => total + (chunk.text?.length || 0),
                0
              ),
              'rag.context_chunk_count': retrievedCount,
              'gen_ai.request.model': MODEL,
              'gen_ai.request.max_tokens': MAX_TOKENS,
            },
          },
          async (promptStage) => {
            const built = buildAnswerParams({ query, chunks });
            promptStage.setAttribute('rag.prompt_chars', built.messages[0].content.length);
            return built;
          }
        );

        if (streaming) {
          beginSse(res);
          emitSse(res, { type: 'sources', sources });
        }

        const final = await instrumentStage(
          {
            name: 'gen_ai.chat.request',
            event: 'gen_ai.chat.request',
            message: 'Claude request completed',
            errorCode: 'ANTHROPIC_REQUEST_FAILED',
            attributes: {
              'gen_ai.system': 'anthropic',
              'gen_ai.request.model': MODEL,
              'gen_ai.operation.name': 'chat',
              'gen_ai.request.max_tokens': MAX_TOKENS,
              'rag.prompt_chars': params.messages[0].content.length,
              'gen_ai.response.stop_reason': 'unknown',
              'gen_ai.response.text_delta_count': 0,
              'gen_ai.response.text_bytes': 0,
            },
            onComplete: ({ duration, outcome, summary }) => {
              recordStream(duration, MODEL, outcome, summary['gen_ai.response.stop_reason']);
            },
          },
          async (streamStage) => {
            let textDeltaCount = 0;
            let textBytes = 0;
            let answer = '';

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
                  answer += event.delta.text;
                  textBytes += Buffer.byteLength(event.delta.text);
                  textDeltaCount += 1;
                  if (streaming) {
                    emitSse(res, { type: 'text', text: event.delta.text });
                  }
                }
              }

              streamStage.setAttributes({
                'gen_ai.response.text_delta_count': textDeltaCount,
                'gen_ai.response.text_bytes': textBytes,
              });

              if (aborted) {
                stopReason = 'cancelled';
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
              return { answer, completed };
            } catch (error) {
              streamStage.setAttributes(providerFailureAttributes(error));
              streamStage.setAttribute('gen_ai.response.stop_reason', 'error');
              throw error;
            }
          }
        );

        if (aborted) {
          ragStage.setAttributes({
            'rag.cancelled': true,
            'gen_ai.response.stop_reason': 'cancelled',
          });
          ragStage.setOutcome('cancelled');
          markRequestCancelled(req);
          return;
        }

        ragStage.setAttribute('gen_ai.response.stop_reason', stopReason);
        if (streaming) {
          emitSse(res, { type: 'done', usage: final.completed.usage, stopReason });
          endSse(res);
        } else {
          res.json({
            answer: final.answer,
            sources,
            usage: final.completed.usage,
            stopReason,
          });
        }
      }
    );
  } catch (error) {
    markRequestError(req, error, 'RAG_CHAT_FAILED');
    if (streaming && res.headersSent && !res.writableEnded && !res.destroyed) {
      emitSse(res, {
        type: 'error',
        message: 'Chat stream failed. Check the server logs using the request ID.',
      });
      emitSse(res, { type: 'done', usage: null, stopReason: 'error' });
      endSse(res);
    } else if (!res.headersSent) {
      res.status(error.status || 500).json({ error: clientErrorMessage(error) });
    }
  }
});

export default router;
