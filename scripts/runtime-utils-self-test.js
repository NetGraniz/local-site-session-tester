'use strict';

const assert = require('node:assert/strict');
const {
  selectCycleDurationSeconds,
  settleWithin
} = require('../lib/runtime-utils');

async function main() {
  assert.equal(selectCycleDurationSeconds({
    durationMode: 'fixed',
    durationSeconds: 27
  }), 27);

  const range = {
    durationMode: 'range',
    minDurationSeconds: 15,
    maxDurationSeconds: 60
  };
  assert.equal(selectCycleDurationSeconds(range, (min, maxExclusive) => {
    assert.equal(min, 15);
    assert.equal(maxExclusive, 61);
    return min;
  }), 15);
  assert.equal(selectCycleDurationSeconds(range, (_min, maxExclusive) => maxExclusive - 1), 60);

  const completed = await settleWithin(Promise.resolve('ok'), 100);
  assert.deepEqual(completed, { timedOut: false, value: 'ok' });

  const rejected = await settleWithin(Promise.reject(new Error('expected')), 100);
  assert.equal(rejected.timedOut, false);
  assert.equal(rejected.error.message, 'expected');

  const started = performance.now();
  const timedOut = await settleWithin(new Promise(() => {}), 25);
  assert.equal(timedOut.timedOut, true);
  assert.ok(performance.now() - started < 500);

  console.log('RUNTIME_UTILS_SELF_TEST_OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
