'use strict';

const crypto = require('node:crypto');

function selectCycleDurationSeconds(settings, randomInteger = crypto.randomInt) {
  if (settings.durationMode !== 'range') return settings.durationSeconds;
  return randomInteger(settings.minDurationSeconds, settings.maxDurationSeconds + 1);
}

async function settleWithin(promise, timeoutMs) {
  let timer = null;
  const guarded = Promise.resolve(promise).then(
    (value) => ({ timedOut: false, value }),
    (error) => ({ timedOut: false, error })
  );
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
  });

  const result = await Promise.race([guarded, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

module.exports = {
  selectCycleDurationSeconds,
  settleWithin
};
