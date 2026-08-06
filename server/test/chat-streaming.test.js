import assert from 'node:assert/strict';
import test from 'node:test';
import { isLlmStreamingEnabled } from '../src/lib/chat-streaming.js';

test('LLM streaming is disabled for empty and unsupported values', () => {
  assert.equal(isLlmStreamingEnabled(''), false);
  assert.equal(isLlmStreamingEnabled('false'), false);
  assert.equal(isLlmStreamingEnabled('yes'), false);
});

test('LLM streaming accepts a case-insensitive true value', () => {
  assert.equal(isLlmStreamingEnabled('true'), true);
  assert.equal(isLlmStreamingEnabled(' TRUE '), true);
});
