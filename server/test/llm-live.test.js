import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import 'dotenv/config';
import { createClient, MODEL } from '../src/lib/claude.js';
import { providerFailureAttributes, safeEndpointOrigin } from '../src/lib/llm-diagnostics.js';

const runLiveTest = process.env.RUN_LLM_LIVE_TESTS === 'true';

function logProbe(event, fields = {}) {
  process.stdout.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      event,
      ...fields,
    })}\n`
  );
}

test(
  'live LLM gateway accepts a minimal streaming request',
  { skip: runLiveTest ? false : 'Set RUN_LLM_LIVE_TESTS=true to enable the live gateway probe.' },
  async () => {
    const requestId = randomUUID();
    const endpoint = safeEndpointOrigin();
    const apiKey = process.env.ANTHROPIC_API_KEY;
    assert.ok(apiKey, 'ANTHROPIC_API_KEY must be configured for the live LLM probe.');
    assert.notEqual(endpoint, 'INVALID_ENDPOINT', 'ANTHROPIC_BASE_URL must be a valid URL.');

    const started = performance.now();
    logProbe('llm.live_probe.started', {
      endpoint,
      model: MODEL,
      request_id: requestId,
      api_key_configured: Boolean(apiKey),
      request_header_names: ['x-request-id'],
      request_parameter_names: ['model', 'max_tokens', 'messages'],
      message_count: 1,
      max_tokens: 16,
    });

    try {
      const stream = createClient().messages.stream(
        {
          model: MODEL,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with OK.' }],
        },
        { headers: { 'x-request-id': requestId } }
      );
      let textDeltaCount = 0;
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          textDeltaCount += 1;
        }
      }

      const completed = await stream.finalMessage();
      const durationMs = Math.round(performance.now() - started);
      logProbe('llm.live_probe.completed', {
        endpoint,
        model: MODEL,
        request_id: requestId,
        duration_ms: durationMs,
        text_delta_count: textDeltaCount,
        input_tokens: completed.usage?.input_tokens,
        output_tokens: completed.usage?.output_tokens,
        stop_reason: completed.stop_reason,
      });
      assert.ok(textDeltaCount > 0, 'The LLM stream returned no text deltas.');
    } catch (error) {
      const providerError = providerFailureAttributes(error);
      logProbe('llm.live_probe.failed', {
        endpoint,
        model: MODEL,
        request_id: requestId,
        duration_ms: Math.round(performance.now() - started),
        ...providerError,
      });
      throw new Error(
        `LLM gateway probe failed (HTTP ${
          providerError['provider.error.status_code'] || 'unknown'
        }; provider code ${providerError['provider.error.code']}).`
      );
    }
  }
);
