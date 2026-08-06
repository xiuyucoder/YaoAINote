import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnswerParams, createClient, MODEL } from '../src/lib/claude.js';
import { providerFailureAttributes, safeEndpointOrigin } from '../src/lib/llm-diagnostics.js';

test('buildAnswerParams uses only supported request fields', () => {
  const params = buildAnswerParams({
    query: 'What is the retention period?',
    chunks: [{ documentName: 'policy.txt', text: 'Retention is seven days.' }],
  });

  assert.deepEqual(Object.keys(params).sort(), ['max_tokens', 'messages', 'model', 'system']);
  assert.equal(params.model, MODEL);
  assert.equal(params.max_tokens, 16000);
  assert.equal(params.messages[0].role, 'user');
  assert.equal('thinking' in params, false);
  assert.equal('output_config' in params, false);
});

test('createClient fails safely when the API key is missing', () => {
  assert.throws(
    () => createClient({ apiKey: '' }),
    (error) => error.telemetryError?.code === 'ANTHROPIC_API_KEY_MISSING'
  );
});

test('provider diagnostics retain only a valid status and code', () => {
  assert.deepEqual(providerFailureAttributes({ status: 401, code: 'authentication_error' }), {
    'provider.status': 'error',
    'provider.error.status_code': 401,
    'provider.error.code': 'authentication_error',
    'provider.error.type': undefined,
    'provider.request_id': undefined,
  });
  assert.deepEqual(providerFailureAttributes({ status: 700, code: 'secret value' }), {
    'provider.status': 'error',
    'provider.error.status_code': undefined,
    'provider.error.code': 'UNKNOWN',
    'provider.error.type': undefined,
    'provider.request_id': undefined,
  });
});

test('provider diagnostics retain safe nested provider identifiers', () => {
  assert.deepEqual(
    providerFailureAttributes({
      status: 429,
      requestID: 'req_123',
      error: { error: { code: 'rate_limit', type: 'api_error' } },
    }),
    {
      'provider.status': 'error',
      'provider.error.status_code': 429,
      'provider.error.code': 'rate_limit',
      'provider.error.type': 'api_error',
      'provider.request_id': 'req_123',
    }
  );
});

test('endpoint diagnostics remove credentials and reject invalid URLs', () => {
  assert.equal(
    safeEndpointOrigin('https://user:password@gateway.example.test/v1'),
    'https://gateway.example.test'
  );
  assert.equal(safeEndpointOrigin('not a URL'), 'INVALID_ENDPOINT');
});
