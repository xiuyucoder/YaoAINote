import assert from 'node:assert/strict';
import test from 'node:test';
import { instrumentStage, startStage } from '../src/lib/observability.js';

test('instrumentStage gives work a stage and completes it once', async () => {
  const completions = [];

  const result = await instrumentStage(
    {
      name: 'test.instrumented',
      event: 'test.instrumented',
      message: 'Instrumented test completed',
      errorCode: 'TEST_INSTRUMENTED_FAILED',
      attributes: { 'test.initial': 1 },
      onComplete: (completion) => completions.push(completion),
    },
    async (stage) => {
      stage.setAttribute('test.result', 2);
      return 'result';
    }
  );

  assert.equal(result, 'result');
  assert.equal(completions.length, 1);
  assert.equal(completions[0].outcome, 'success');
  assert.equal(completions[0].summary['test.initial'], 1);
  assert.equal(completions[0].summary['test.result'], 2);
});

test('instrumentStage finalizes failures once before rethrowing', async () => {
  const completions = [];
  const failure = new Error('expected failure');

  await assert.rejects(
    instrumentStage(
      {
        name: 'test.failure',
        event: 'test.failure',
        message: 'Failing test completed',
        errorCode: 'TEST_FAILURE',
        attributes: {},
        onComplete: (completion) => completions.push(completion),
      },
      async () => {
        throw failure;
      }
    ),
    failure
  );

  assert.equal(completions.length, 1);
  assert.equal(completions[0].outcome, 'server_error');
  assert.equal(completions[0].error.code, 'TEST_FAILURE');
});

test('startStage leaves completion under the caller control', () => {
  const completions = [];
  const stage = startStage({
    name: 'test.long_lived',
    event: 'test.long_lived',
    message: 'Long-lived test completed',
    errorCode: 'TEST_LONG_LIVED_FAILED',
    attributes: {},
    onComplete: (completion) => completions.push(completion),
  });

  stage.run(() => stage.setAttribute('test.events', 3));
  assert.equal(completions.length, 0);

  stage.complete();
  stage.complete();

  assert.equal(completions.length, 1);
  assert.equal(completions[0].summary['test.events'], 3);
});
