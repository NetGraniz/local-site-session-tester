'use strict';

function createAbortError() {
  const error = new Error('Операция отменена');
  error.name = 'AbortError';
  return error;
}

function abortableDelay(milliseconds, abortSignal) {
  if (abortSignal.aborted) return Promise.reject(createAbortError());
  if (milliseconds <= 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      abortSignal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    abortSignal.addEventListener('abort', onAbort, { once: true });
  });
}

async function runWorkerSlot({
  slotId,
  options,
  abortSignal,
  initialDelayMs = 0,
  runCycle
}) {
  let cycle = 0;

  try {
    if (initialDelayMs > 0) await abortableDelay(initialDelayMs, abortSignal);

    while (!abortSignal.aborted) {
      cycle += 1;
      const outcome = await runCycle({ slotId, cycle, abortSignal });

      if (abortSignal.aborted || outcome.stopped) break;
      if (!options.repeatEnabled) break;
      if (options.repeatMode === 'limited' && cycle >= options.maxCycles) break;
      if (outcome.error && options.stopSlotOnError) break;

      await abortableDelay(options.restartDelayMs, abortSignal);
    }
  } catch (error) {
    if (!abortSignal.aborted && error.name !== 'AbortError') throw error;
  }

  return { slotId, cycles: cycle };
}

module.exports = {
  abortableDelay,
  runWorkerSlot
};
