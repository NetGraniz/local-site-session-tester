'use strict';

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('playwright');
const { runWorkerSlot } = require('../lib/scheduler');

async function main() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Repeat test</title><p>OK</p>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  let browser;
  try {
    const address = server.address();
    const url = `http://127.0.0.1:${address.port}/`;
    browser = await chromium.launch({ headless: true });

    const controller = new AbortController();
    const seenContexts = new WeakSet();
    const runIds = new Set();
    let createdContexts = 0;
    let openContexts = 0;
    let peakOpenContexts = 0;
    const slotCount = 3;
    const cyclesPerSlot = 3;
    const options = {
      repeatEnabled: true,
      repeatMode: 'limited',
      maxCycles: cyclesPerSlot,
      restartDelayMs: 1,
      stopSlotOnError: false
    };

    const workers = Array.from({ length: slotCount }, (_, index) => runWorkerSlot({
      slotId: index + 1,
      options,
      abortSignal: controller.signal,
      runCycle: async ({ slotId, cycle }) => {
        const runId = `slot-${slotId}-cycle-${cycle}`;
        const context = await browser.newContext();
        assert.equal(seenContexts.has(context), false);
        seenContexts.add(context);
        createdContexts += 1;
        openContexts += 1;
        peakOpenContexts = Math.max(peakOpenContexts, openContexts);

        try {
          const page = await context.newPage();
          const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
          assert.equal(response.status(), 200);
          const initialState = await page.evaluate(() => ({
            local: localStorage.getItem('cycle'),
            session: sessionStorage.getItem('cycle'),
            cookies: document.cookie
          }));
          assert.deepEqual(initialState, { local: null, session: null, cookies: '' });
          await page.evaluate((value) => {
            localStorage.setItem('cycle', value);
            sessionStorage.setItem('cycle', value);
            document.cookie = `cycle=${value}; path=/`;
          }, runId);
          runIds.add(runId);
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { error: false, stopped: false };
        } finally {
          await context.close();
          openContexts -= 1;
        }
      }
    }));

    await Promise.all(workers);
    assert.equal(createdContexts, slotCount * cyclesPerSlot);
    assert.equal(runIds.size, slotCount * cyclesPerSlot);
    assert.equal(openContexts, 0);
    assert.equal(peakOpenContexts, slotCount);
    console.log('REPEAT_BROWSER_SELF_TEST_OK');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
