'use strict';

const assert = require('node:assert/strict');
const { runWorkerSlot } = require('../lib/scheduler');

const baseOptions = {
  repeatEnabled: true,
  repeatMode: 'limited',
  maxCycles: 3,
  restartDelayMs: 0,
  stopSlotOnError: false
};

async function testSingleCycle() {
  const controller = new AbortController();
  const calls = [];
  const result = await runWorkerSlot({
    slotId: 1,
    options: { ...baseOptions, repeatEnabled: false },
    abortSignal: controller.signal,
    runCycle: async ({ slotId, cycle }) => {
      calls.push(`slot-${slotId}-cycle-${cycle}`);
      return { error: false, stopped: false };
    }
  });
  assert.deepEqual(calls, ['slot-1-cycle-1']);
  assert.equal(result.cycles, 1);
}

async function testLimitedCycles() {
  const controller = new AbortController();
  const calls = [];
  const result = await runWorkerSlot({
    slotId: 3,
    options: baseOptions,
    abortSignal: controller.signal,
    runCycle: async ({ slotId, cycle }) => {
      calls.push(`slot-${slotId}-cycle-${cycle}`);
      return { error: false, stopped: false };
    }
  });
  assert.deepEqual(calls, [
    'slot-3-cycle-1',
    'slot-3-cycle-2',
    'slot-3-cycle-3'
  ]);
  assert.equal(result.cycles, 3);
}

async function testErrorModes() {
  const continuingController = new AbortController();
  let continuingCalls = 0;
  await runWorkerSlot({
    slotId: 1,
    options: baseOptions,
    abortSignal: continuingController.signal,
    runCycle: async () => {
      continuingCalls += 1;
      return { error: true, stopped: false };
    }
  });
  assert.equal(continuingCalls, 3);

  const stoppingController = new AbortController();
  let stoppingCalls = 0;
  await runWorkerSlot({
    slotId: 1,
    options: { ...baseOptions, stopSlotOnError: true },
    abortSignal: stoppingController.signal,
    runCycle: async () => {
      stoppingCalls += 1;
      return { error: true, stopped: false };
    }
  });
  assert.equal(stoppingCalls, 1);
}

async function testAbortDuringRestartDelay() {
  const controller = new AbortController();
  let calls = 0;
  const worker = runWorkerSlot({
    slotId: 1,
    options: { ...baseOptions, repeatMode: 'unlimited', restartDelayMs: 10000 },
    abortSignal: controller.signal,
    runCycle: async () => {
      calls += 1;
      return { error: false, stopped: false };
    }
  });
  setTimeout(() => controller.abort(), 20);
  await worker;
  assert.equal(calls, 1);
}

async function testFixedWorkerPool() {
  const controller = new AbortController();
  let active = 0;
  let peakActive = 0;
  const slotCount = 5;
  const workers = Array.from({ length: slotCount }, (_, index) => runWorkerSlot({
    slotId: index + 1,
    options: { ...baseOptions, maxCycles: 2 },
    abortSignal: controller.signal,
    runCycle: async () => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { error: false, stopped: false };
    }
  }));
  await Promise.all(workers);
  assert.equal(workers.length, slotCount);
  assert.equal(peakActive, slotCount);
}

async function main() {
  await testSingleCycle();
  await testLimitedCycles();
  await testErrorModes();
  await testAbortDuringRestartDelay();
  await testFixedWorkerPool();
  console.log('SCHEDULER_SELF_TEST_OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
