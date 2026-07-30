'use strict';

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require('playwright');
const {
  createSeededRandom,
  generateSeed,
  parseLineList,
  performCopyServerAddressAction,
  performRandomActions,
  randomInteger,
  safeUrl,
  throwIfAborted
} = require('../lib/random-actions');

function baseSettings(url) {
  return {
    url,
    randomActionsMin: 1,
    randomActionsMax: 1,
    actionDelayMinMs: 100,
    actionDelayMaxMs: 100,
    actionTimeoutMs: 2500,
    maxNavigationDepth: 3,
    allowInternalNavigation: false,
    allowButtonClicks: false,
    allowScrolling: false,
    allowGoBack: false,
    allowedSelectors: '',
    blockedSelectors: [
      'button[type="submit"]',
      'a[target="_blank"]',
      '.danger',
      '.delete'
    ].join('\n'),
    autoDiscoverSafeElements: false,
    blockedActionWords: 'удалить\ndelete\ncheckout',
    copyServerAddressSelector: 'server-card button.copy'
  };
}

async function withPage(browser, url, callback) {
  const context = await browser.newContext({ viewport: { width: 900, height: 600 } });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    return await callback(page);
  } finally {
    await context.close();
  }
}

async function main() {
  const randomA = createSeededRandom(184729);
  const randomB = createSeededRandom(184729);
  assert.deepEqual(
    Array.from({ length: 8 }, () => randomA()),
    Array.from({ length: 8 }, () => randomB())
  );
  assert.equal(generateSeed('184729'), 184729);
  assert.deepEqual(parseLineList(' nav a \n\nbutton\nnav a'), ['nav a', 'button', 'nav a']);
  assert.equal(
    safeUrl('https://example.com/servers?page=2&token=secret#section'),
    'https://example.com/servers?page=2&token=%5Bredacted%5D#section'
  );
  assert.equal(randomInteger(() => 0, 1, 5), 1);
  assert.equal(randomInteger(() => 0.999999, 1, 5), 5);
  const aborted = new AbortController();
  aborted.abort();
  assert.throws(() => throwIfAborted(aborted.signal), { name: 'AbortError' });

  let dangerClicks = 0;
  let submitClicks = 0;
  let associatedSubmitClicks = 0;
  let ariaMaskedClicks = 0;
  let safeClicks = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/event/danger') dangerClicks += 1;
    if (request.url === '/event/submit') submitClicks += 1;
    if (request.url === '/event/associated-submit') associatedSubmitClicks += 1;
    if (request.url === '/event/aria-masked') ariaMaskedClicks += 1;
    if (request.url === '/event/safe') safeClicks += 1;

    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (request.url === '/inside') {
      response.end('<!doctype html><title>Inside</title><main><h1>Внутренний раздел</h1></main>');
      return;
    }
    response.end(`<!doctype html>
      <title>Random actions test</title>
      <style>body{margin:0} .space{height:3200px}</style>
      <nav>
        <a class="safe-link" href="/inside">Внутренний раздел</a>
        <a class="external-link" href="https://example.org/outside">Внешний раздел</a>
        <a class="blank-link" href="/inside" target="_blank">Новое окно</a>
        <a class="mail-link" href="mailto:test@example.com">Почта</a>
      </nav>
      <main>
        <button class="safe-button" type="button"
          onclick="fetch('/event/safe'); document.querySelector('#state').textContent='safe-clicked'">
          Показать детали
        </button>
        <button class="danger" type="button" onclick="fetch('/event/danger')">Удалить сервер</button>
        <form onsubmit="fetch('/event/submit'); return false">
          <button class="form-button" type="submit">Подтвердить</button>
        </form>
        <form id="associated-form" onsubmit="fetch('/event/associated-submit'); return false"></form>
        <button class="associated-submit" form="associated-form">Продолжить</button>
        <button class="aria-mask" type="button" aria-label="Показать детали"
          onclick="fetch('/event/aria-masked')">Удалить безвозвратно</button>
        <server-card><button class="copy" type="button"
          onclick="document.querySelector('#state').textContent='copied'">Копировать адрес</button></server-card>
        <div id="state">initial</div>
        <div class="space"></div>
      </main>`);
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

    await withPage(browser, url, async (page) => {
      const events = [];
      const settings = {
        ...baseSettings(url),
        allowButtonClicks: true,
        allowedSelectors: '.safe-button\n.danger\n.form-button\n.associated-submit\n.aria-mask'
      };
      const result = await performRandomActions({
        page,
        settings,
        abortSignal: new AbortController().signal,
        seed: 1,
        onAction: (event) => events.push(event)
      });
      assert.equal(result.completed, 1);
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'click');
      assert.equal(events[0].success, true);
      assert.equal(await page.locator('#state').textContent(), 'safe-clicked');
      assert.equal(dangerClicks, 0);
      assert.equal(submitClicks, 0);
      assert.equal(associatedSubmitClicks, 0);
      assert.equal(ariaMaskedClicks, 0);
    });

    await withPage(browser, url, async (page) => {
      const events = [];
      const settings = {
        ...baseSettings(url),
        allowButtonClicks: true,
        autoDiscoverSafeElements: true
      };
      const result = await performRandomActions({
        page,
        settings,
        abortSignal: new AbortController().signal,
        seed: 7,
        onAction: (event) => events.push(event)
      });
      assert.equal(result.completed, 1);
      assert.equal(events[0].success, true);
      assert.ok(['safe-clicked', 'copied'].includes(await page.locator('#state').textContent()));
      assert.equal(dangerClicks, 0);
      assert.equal(submitClicks, 0);
      assert.equal(associatedSubmitClicks, 0);
      assert.equal(ariaMaskedClicks, 0);
    });

    await withPage(browser, url, async (page) => {
      const events = [];
      const settings = {
        ...baseSettings(url),
        allowInternalNavigation: true,
        allowedSelectors: 'nav a'
      };
      await performRandomActions({
        page,
        settings,
        abortSignal: new AbortController().signal,
        seed: 2,
        onAction: (event) => events.push(event)
      });
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'navigate');
      assert.equal(events[0].success, true);
      assert.equal(new URL(page.url()).pathname, '/inside');
      assert.equal(new URL(page.url()).origin, new URL(url).origin);
    });

    const traces = [];
    for (let run = 0; run < 2; run += 1) {
      traces.push(await withPage(browser, url, async (page) => {
        const events = [];
        const settings = {
          ...baseSettings(url),
          randomActionsMin: 3,
          randomActionsMax: 3,
          allowScrolling: true
        };
        await performRandomActions({
          page,
          settings,
          abortSignal: new AbortController().signal,
          seed: 184729,
          onAction: (event) => events.push({
            type: event.type,
            text: event.text,
            success: event.success
          })
        });
        return events;
      }));
    }
    assert.deepEqual(traces[0], traces[1]);
    assert.equal(traces[0].length, 3);
    assert.ok(traces[0].every((event) => event.type === 'scroll'));

    await withPage(browser, url, async (page) => {
      const controller = new AbortController();
      let actionCount = 0;
      const settings = {
        ...baseSettings(url),
        randomActionsMin: 3,
        randomActionsMax: 3,
        allowScrolling: true
      };
      await assert.rejects(
        performRandomActions({
          page,
          settings,
          abortSignal: controller.signal,
          seed: 99,
          onAction: () => {
            actionCount += 1;
            controller.abort();
          }
        }),
        { name: 'AbortError' }
      );
      assert.equal(actionCount, 1);
    });

    await withPage(browser, url, async (page) => {
      const event = await performCopyServerAddressAction({
        page,
        settings: baseSettings(url),
        abortSignal: new AbortController().signal
      });
      assert.equal(event.success, true);
      assert.equal(await page.locator('#state').textContent(), 'copied');
    });

    await withPage(browser, url, async (page) => {
      const settings = {
        ...baseSettings(url),
        allowButtonClicks: true,
        allowedSelectors: '.safe-button'
      };
      const expired = await performRandomActions({
        page,
        settings,
        abortSignal: new AbortController().signal,
        seed: 1,
        deadlineAt: performance.now()
      });
      assert.equal(expired.completed, 0);

      const copyExpired = await performCopyServerAddressAction({
        page,
        settings,
        abortSignal: new AbortController().signal,
        deadlineAt: performance.now()
      });
      assert.equal(copyExpired.success, false);
      assert.equal(copyExpired.result, 'время цикла истекло');
      assert.equal(await page.locator('#state').textContent(), 'initial');
    });

    await withPage(browser, url, async (page) => {
      const settings = {
        ...baseSettings(url),
        allowButtonClicks: true,
        allowedSelectors: '.safe-button',
        blockedSelectors: ':not('
      };
      await assert.rejects(
        performRandomActions({
          page,
          settings,
          abortSignal: new AbortController().signal,
          seed: 1
        }),
        /Некорректный запрещённый CSS-селектор/
      );
      assert.equal(await page.locator('#state').textContent(), 'initial');
    });

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(dangerClicks, 0);
    assert.equal(submitClicks, 0);
    assert.equal(associatedSubmitClicks, 0);
    assert.equal(ariaMaskedClicks, 0);
    assert.ok(safeClicks >= 1);
    console.log('RANDOM_ACTIONS_SELF_TEST_OK');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
