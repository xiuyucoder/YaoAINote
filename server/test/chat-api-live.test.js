import assert from 'node:assert/strict';
import test from 'node:test';
import 'dotenv/config';

const runLiveTest = process.env.RUN_CHAT_API_LIVE_TESTS === 'true';
const baseUrl = process.env.CHAT_API_BASE_URL || 'http://localhost:3001';
const apiKey = process.env.CHAT_API_KEY || process.env.APP_API_KEY;

function localChatUrl() {
  const url = new URL('/api/chat', baseUrl);
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  assert.ok(
    localHosts.has(url.hostname),
    'CHAT_API_BASE_URL must point to a local server (localhost, 127.0.0.1, or ::1).'
  );
  return url;
}

test(
  'local /api/chat accepts an authenticated chat request',
  { skip: runLiveTest ? false : 'Set RUN_CHAT_API_LIVE_TESTS=true to enable the local API probe.' },
  async () => {
    assert.ok(apiKey, 'Set CHAT_API_KEY or APP_API_KEY for the local API probe.');

    let response;
    try {
      response = await fetch(localChatUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          query: 'Give a brief answer based on my uploaded documents.',
          topK: 1,
        }),
      });
    } catch (error) {
      throw new Error(
        `Could not reach local /api/chat at ${localChatUrl().origin}. Start the server first.`,
        { cause: error }
      );
    }

    assert.equal(response.status, 200, `Expected HTTP 200 but received ${response.status}.`);
    assert.match(
      response.headers.get('content-type') || '',
      /^application\/json\b/i,
      'Expected a JSON response.'
    );

    const payload = await response.json();
    assert.equal(typeof payload.answer, 'string');
    assert.ok(payload.answer.trim(), 'Expected a non-empty answer.');
    assert.ok(Array.isArray(payload.sources), 'Expected sources to be an array.');
    assert.ok(
      payload.stopReason === 'no_context' || typeof payload.stopReason === 'string',
      'Expected a stopReason.'
    );
  }
);
