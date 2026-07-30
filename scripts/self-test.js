'use strict';

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

const http = require('node:http');
const { chromium } = require('playwright');

async function main() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Self test</title><p>OK</p>');
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
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const firstPage = await firstContext.newPage();
    const secondPage = await secondContext.newPage();

    const firstResponse = await firstPage.goto(url, { waitUntil: 'domcontentloaded' });
    const secondResponse = await secondPage.goto(url, { waitUntil: 'domcontentloaded' });
    if (firstResponse.status() !== 200 || secondResponse.status() !== 200) {
      throw new Error('Локальная тестовая страница вернула неожиданный HTTP-код.');
    }

    await firstPage.evaluate(() => {
      localStorage.setItem('isolation-check', 'first-context');
      document.cookie = 'isolation-check=first-context; path=/';
    });
    const secondValues = await secondPage.evaluate(() => ({
      storage: localStorage.getItem('isolation-check'),
      cookies: document.cookie
    }));

    if (secondValues.storage !== null || secondValues.cookies.includes('isolation-check')) {
      throw new Error('BrowserContext не обеспечил ожидаемую изоляцию данных.');
    }

    await Promise.all([firstContext.close(), secondContext.close()]);
    console.log('BROWSER_ISOLATION_OK');
  } finally {
    if (browser) await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
