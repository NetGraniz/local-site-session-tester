'use strict';

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const { abortableDelay, runWorkerSlot } = require('./lib/scheduler');
const { selectCycleDurationSeconds, settleWithin } = require('./lib/runtime-utils');

const MAX_PARALLEL_SESSIONS = 50;
const MAX_CYCLES_PER_SLOT = 100000;
const MIN_DURATION_SECONDS = 10;
const MAX_DURATION_SECONDS = 86400;
const RESOURCE_CLOSE_TIMEOUT_MS = 2000;
const BROWSER_KILL_TIMEOUT_MS = 5000;
const STOP_COMPLETION_TIMEOUT_MS = 10000;
const DEFAULT_SETTINGS = Object.freeze({
  url: 'https://example.com',
  sessionCount: 5,
  durationMode: 'fixed',
  durationSeconds: 15,
  minDurationSeconds: 15,
  maxDurationSeconds: 60,
  launchDelayMs: 300,
  navigationTimeoutMs: 30000,
  headless: true,
  viewportWidth: 1280,
  viewportHeight: 720,
  repeatEnabled: false,
  repeatMode: 'unlimited',
  maxCycles: 10,
  restartDelayMs: 1000,
  stopSlotOnError: false
});

let mainWindow = null;
let closingConfirmed = false;
let currentRun = null;
let settingsPath = '';
let logsDirectory = '';
let settings = { ...DEFAULT_SETTINGS };
let logWriteQueue = Promise.resolve();

function emptyStatistics(planned = 0) {
  return {
    planned,
    started: 0,
    active: 0,
    completed: 0,
    stopped: 0,
    averageLoadMs: 0,
    totalCycles: 0,
    currentCycle: 0,
    restarted: 0,
    errorCycles: 0,
    cyclesPerMinute: 0
  };
}

let publicState = {
  running: false,
  settings: { ...DEFAULT_SETTINGS },
  sessions: [],
  statistics: emptyStatistics()
};

function serializableError(error) {
  if (!error) return 'Неизвестная ошибка';
  return String(error.message || error).replace(/\s+/g, ' ').trim();
}

function formatDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function fileTimestamp(date = new Date()) {
  return formatDate(date).replace(' ', '-').replaceAll(':', '-');
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function sendTerminal(run, channel, payload) {
  if (run.terminalEventSent) return;
  run.terminalEventSent = true;
  send(channel, payload);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function finishPublicRun(run) {
  if (currentRun !== run) return;
  publicState.running = false;
  publicState.sessions = clone(run.sessions);
  publicState.statistics = calculateStatistics(run);
  currentRun = null;
}

async function ensureDataDirectories() {
  const userData = app.getPath('userData');
  settingsPath = path.join(userData, 'settings.json');
  logsDirectory = path.join(userData, 'logs');
  await fsp.mkdir(logsDirectory, { recursive: true });
}

async function loadSettings() {
  try {
    const raw = await fsp.readFile(settingsPath, 'utf8');
    settings = validateSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
  } catch (error) {
    settings = { ...DEFAULT_SETTINGS };
    if (error.code !== 'ENOENT') {
      console.warn('Не удалось прочитать settings.json, используются значения по умолчанию:', serializableError(error));
    }
  }
  publicState.settings = { ...settings };
}

async function saveSettings(nextSettings) {
  settings = { ...nextSettings };
  publicState.settings = { ...settings };
  const temporaryPath = `${settingsPath}.tmp`;
  await fsp.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  try {
    await fsp.rename(temporaryPath, settingsPath);
  } catch {
    await fsp.rm(settingsPath, { force: true });
    await fsp.rename(temporaryPath, settingsPath);
  }
}

function validateInteger(value, label, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${label}: укажите целое число от ${min} до ${max}.`);
  }
  return number;
}

function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Параметры теста имеют неверный формат.');
  }

  let url;
  try {
    url = new URL(String(input.url || '').trim());
  } catch {
    throw new Error('Введите корректный URL сайта.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Разрешены только адреса с http:// или https://.');
  }
  if (url.username || url.password) {
    throw new Error('URL не должен содержать имя пользователя или пароль.');
  }

  const repeatMode = input.repeatMode === 'limited' ? 'limited' : 'unlimited';
  const durationMode = input.durationMode === 'range' ? 'range' : 'fixed';
  const durationSeconds = validateInteger(
    input.durationSeconds,
    'Фиксированная длительность',
    MIN_DURATION_SECONDS,
    MAX_DURATION_SECONDS
  );
  const minDurationSeconds = validateInteger(
    input.minDurationSeconds,
    'Минимальная длительность',
    MIN_DURATION_SECONDS,
    MAX_DURATION_SECONDS
  );
  const maxDurationSeconds = validateInteger(
    input.maxDurationSeconds,
    'Максимальная длительность',
    MIN_DURATION_SECONDS,
    MAX_DURATION_SECONDS
  );
  if (durationMode === 'range' && maxDurationSeconds < minDurationSeconds) {
    throw new Error('Максимальная длительность не может быть меньше минимальной.');
  }

  return {
    url: url.href,
    sessionCount: validateInteger(input.sessionCount, 'Количество сессий', 1, MAX_PARALLEL_SESSIONS),
    durationMode,
    durationSeconds,
    minDurationSeconds,
    maxDurationSeconds,
    launchDelayMs: validateInteger(input.launchDelayMs, 'Задержка запуска', 0, 60000),
    navigationTimeoutMs: validateInteger(input.navigationTimeoutMs, 'Тайм-аут загрузки', 1000, 300000),
    headless: input.headless !== false,
    viewportWidth: validateInteger(input.viewportWidth, 'Ширина окна', 320, 7680),
    viewportHeight: validateInteger(input.viewportHeight, 'Высота окна', 240, 4320),
    repeatEnabled: input.repeatEnabled === true,
    repeatMode,
    maxCycles: validateInteger(input.maxCycles, 'Количество циклов', 1, MAX_CYCLES_PER_SLOT),
    restartDelayMs: validateInteger(input.restartDelayMs, 'Задержка перезапуска', 0, 3600000),
    stopSlotOnError: input.stopSlotOnError === true
  };
}

function calculateStatistics(run) {
  const elapsedMinutes = Math.max((performance.now() - run.startedAtPerformance) / 60000, 1 / 60000);
  return {
    planned: run.sessions.length,
    started: run.metrics.cyclesStarted,
    active: run.sessions.filter((session) => ['Запуск', 'Загрузка', 'Активно'].includes(session.status)).length,
    completed: run.metrics.cyclesSucceeded,
    stopped: run.sessions.filter((session) => session.status === 'Остановлено').length,
    averageLoadMs: run.metrics.loadCount ? Math.round(run.metrics.loadTotalMs / run.metrics.loadCount) : 0,
    totalCycles: run.metrics.cyclesCompleted,
    currentCycle: run.metrics.currentCycle,
    restarted: run.metrics.restarted,
    errorCycles: run.metrics.cyclesErrored,
    cyclesPerMinute: Number((run.metrics.cyclesCompleted / elapsedMinutes).toFixed(1))
  };
}

function publishStatistics(run) {
  if (currentRun !== run) return;
  publicState.statistics = calculateStatistics(run);
  send('statistics-updated', clone(publicState.statistics));
}

function publishSession(run, session) {
  if (currentRun !== run) return;
  publicState.sessions[session.slotId - 1] = clone(session);
  send('session-updated', clone(session));
  publishStatistics(run);
}

function updateSession(run, session, patch) {
  Object.assign(session, patch);
  publishSession(run, session);
}

function markUnfinishedSessionsStopped(run) {
  for (const session of run.sessions) {
    if (['Ожидание', 'Запуск', 'Загрузка', 'Активно'].includes(session.status)) {
      updateSession(run, session, {
        status: 'Остановлено',
        errorText: session.cycle > 0
          ? 'Остановлено пользователем'
          : 'Не запущено: тест остановлен'
      });
    }
  }
}

function createLogger(run) {
  run.logPath = path.join(logsDirectory, `session-${fileTimestamp()}.log`);
  return (level, message) => {
    const cleanMessage = String(message).replace(/[\r\n]+/g, ' ').trim();
    const entry = {
      timestamp: formatDate(),
      level,
      message: cleanMessage
    };
    const line = `[${entry.timestamp}] [${level}] ${cleanMessage}\n`;
    logWriteQueue = logWriteQueue
      .then(() => fsp.appendFile(run.logPath, line, 'utf8'))
      .catch((error) => console.error('Ошибка записи журнала:', error));
    send('log-message', entry);
  };
}

function resolveBrowserExecutable() {
  const expected = chromium.executablePath();
  if (!app.isPackaged || !expected.includes('app.asar')) return expected;
  const unpacked = expected.replace('app.asar', 'app.asar.unpacked');
  return fs.existsSync(unpacked) ? unpacked : expected;
}

function recordCompletedCycle(run, outcome, loadTimeMs = null) {
  run.metrics.cyclesCompleted += 1;
  if (outcome === 'success') run.metrics.cyclesSucceeded += 1;
  if (outcome === 'error') run.metrics.cyclesErrored += 1;
  if (Number.isFinite(loadTimeMs)) {
    run.metrics.loadTotalMs += loadTimeMs;
    run.metrics.loadCount += 1;
  }
}

async function runIsolatedSession(run, session, cycle, abortSignal) {
  let context = null;
  let page = null;
  const runId = `slot-${session.slotId}-cycle-${cycle}`;
  const cycleDurationSeconds = selectCycleDurationSeconds(run.settings);

  if (abortSignal.aborted) return { stopped: true, error: false };

  run.metrics.cyclesStarted += 1;
  run.metrics.currentCycle = Math.max(run.metrics.currentCycle, cycle);
  if (cycle > 1) run.metrics.restarted += 1;

  updateSession(run, session, {
    cycle,
    restartCount: cycle - 1,
    runId,
    durationSeconds: cycleDurationSeconds,
    status: 'Запуск',
    httpStatus: null,
    loadTimeMs: null,
    startedAt: formatDate(),
    errorText: ''
  });
  run.log('INFO', `${runId}: запуск нового изолированного контекста на ${cycleDurationSeconds} сек.`);

  try {
    if (abortSignal.aborted) return { stopped: true, error: false };

    context = await run.browser.newContext({
      viewport: {
        width: run.settings.viewportWidth,
        height: run.settings.viewportHeight
      }
    });
    run.contexts.add(context);

    if (abortSignal.aborted) throw new Error('Тест остановлен пользователем');

    page = await context.newPage();
    run.pages.add(page);
    updateSession(run, session, { status: 'Загрузка' });

    const started = performance.now();
    const response = await page.goto(run.settings.url, {
      waitUntil: 'domcontentloaded',
      timeout: run.settings.navigationTimeoutMs
    });
    const loadTimeMs = Math.round(performance.now() - started);
    const httpStatus = response ? response.status() : null;

    if (abortSignal.aborted) throw new Error('Тест остановлен пользователем');

    if (httpStatus !== null && httpStatus >= 400) {
      const statusText = response.statusText() || 'Ошибка HTTP';
      const errorText = `HTTP ${httpStatus} ${statusText}`.trim();
      recordCompletedCycle(run, 'error', loadTimeMs);
      updateSession(run, session, {
        status: 'Ошибка',
        httpStatus,
        loadTimeMs,
        errorText
      });
      run.log('WARN', `${runId}: сервер вернул ${errorText}, загрузка ${loadTimeMs} мс.`);
      return { stopped: false, error: true };
    }

    updateSession(run, session, {
      status: 'Активно',
      httpStatus,
      loadTimeMs,
      errorText: ''
    });
    run.log('INFO', `${runId}: страница загружена за ${loadTimeMs} мс, HTTP ${httpStatus ?? 'нет ответа'}.`);

    const durationMilliseconds = process.argv.includes('--cycle-smoke-test')
      ? 0
      : cycleDurationSeconds * 1000;
    await abortableDelay(durationMilliseconds, abortSignal);
    if (abortSignal.aborted) throw new Error('Тест остановлен пользователем');

    recordCompletedCycle(run, 'success', loadTimeMs);
    updateSession(run, session, { status: 'Завершено' });
    run.log('INFO', `${runId}: цикл завершён.`);
    return { stopped: false, error: false };
  } catch (error) {
    if (abortSignal.aborted || error.name === 'AbortError') {
      updateSession(run, session, {
        status: 'Остановлено',
        errorText: 'Остановлено пользователем'
      });
      run.log('WARN', `${runId}: цикл остановлен пользователем.`);
      return { stopped: true, error: false };
    }

    const message = serializableError(error);
    recordCompletedCycle(run, 'error');
    updateSession(run, session, {
      status: 'Ошибка',
      errorText: message
    });
    run.log('ERROR', `${runId}: ${message}`);
    return { stopped: false, error: true };
  } finally {
    if (page) {
      run.pages.delete(page);
      await closeResourceWithin(run, page, 'страница');
    }
    if (context) {
      run.contexts.delete(context);
      await closeResourceWithin(run, context, 'контекст');
    }
  }
}

async function closeResourceWithin(run, resource, label, timeoutMs = RESOURCE_CLOSE_TIMEOUT_MS) {
  if (!resource || run.closingResources.has(resource)) return;
  run.closingResources.add(resource);
  const result = await settleWithin(
    Promise.resolve().then(() => resource.close()),
    timeoutMs
  );
  if (result.timedOut) {
    run.log('WARN', `Закрытие ресурса «${label}» превысило ${timeoutMs} мс; продолжаю принудительную остановку.`);
  } else if (result.error) {
    run.log('WARN', `Не удалось мягко закрыть ресурс «${label}»: ${serializableError(result.error)}.`);
  }
}

async function closeRunResources(run) {
  const pages = [...run.pages];
  const contexts = [...run.contexts];
  run.pages.clear();
  run.contexts.clear();

  await Promise.all([
    ...pages.map((page) => closeResourceWithin(run, page, 'страница')),
    ...contexts.map((context) => closeResourceWithin(run, context, 'контекст'))
  ]);

  if (run.browser) {
    const browser = run.browser;
    run.browser = null;
    await closeResourceWithin(run, browser, 'соединение с Chromium');
  }

  if (run.browserServer) {
    const browserServer = run.browserServer;
    run.browserServer = null;
    const result = await settleWithin(
      Promise.resolve().then(() => browserServer.kill()),
      BROWSER_KILL_TIMEOUT_MS
    );
    if (result.timedOut) {
      run.log('ERROR', `Принудительное завершение Chromium превысило ${BROWSER_KILL_TIMEOUT_MS} мс.`);
    } else if (result.error) {
      run.log('WARN', `Chromium уже завершён или недоступен: ${serializableError(result.error)}.`);
    }
  }
}

async function executeRun(run) {
  try {
    const repeatDescription = run.settings.repeatEnabled
      ? run.settings.repeatMode === 'limited'
        ? `до ${run.settings.maxCycles} циклов на слот`
        : 'без ограничения циклов'
      : 'по одному циклу на слот';
    run.log('INFO', `Тест начат: ${run.settings.sessionCount} рабочих слотов, ${repeatDescription}, адрес ${run.settings.url}.`);

    run.browserServer = await chromium.launchServer({
      headless: run.settings.headless,
      executablePath: resolveBrowserExecutable()
    });

    if (run.abortController.signal.aborted) {
      markUnfinishedSessionsStopped(run);
      await closeRunResources(run);
      run.log('WARN', 'Тест остановлен до запуска рабочих слотов.');
      sendTerminal(run, 'test-stopped', clone(calculateStatistics(run)));
      return;
    }

    run.browser = await chromium.connect(run.browserServer.wsEndpoint());

    if (run.abortController.signal.aborted) {
      markUnfinishedSessionsStopped(run);
      await closeRunResources(run);
      run.log('WARN', 'Тест остановлен до запуска рабочих слотов.');
      sendTerminal(run, 'test-stopped', clone(calculateStatistics(run)));
      return;
    }

    run.workers = run.sessions.map((session, index) => runWorkerSlot({
      slotId: session.slotId,
      options: run.settings,
      abortSignal: run.abortController.signal,
      initialDelayMs: index * run.settings.launchDelayMs,
      runCycle: ({ cycle, abortSignal }) => runIsolatedSession(run, session, cycle, abortSignal)
    }));

    await Promise.allSettled(run.workers);
    if (run.abortController.signal.aborted) markUnfinishedSessionsStopped(run);
    await closeRunResources(run);

    if (run.abortController.signal.aborted) {
      run.log('WARN', 'Тест остановлен пользователем.');
      sendTerminal(run, 'test-stopped', clone(calculateStatistics(run)));
    } else {
      run.log('INFO', 'Все рабочие слоты завершены.');
      sendTerminal(run, 'test-finished', clone(calculateStatistics(run)));
    }
  } catch (error) {
    if (run.abortController.signal.aborted) {
      markUnfinishedSessionsStopped(run);
      await closeRunResources(run);
      run.log('WARN', 'Тест остановлен пользователем во время запуска или завершения Chromium.');
      sendTerminal(run, 'test-stopped', clone(calculateStatistics(run)));
      return;
    }

    const message = serializableError(error);
    run.abortController.abort();
    run.log('ERROR', `Критическая ошибка запуска Chromium: ${message}`);
    for (const session of run.sessions) {
      if (!['Завершено', 'Ошибка', 'Остановлено'].includes(session.status)) {
        updateSession(run, session, {
          status: 'Ошибка',
          errorText: message
        });
      }
    }
    await closeRunResources(run);
    sendTerminal(run, 'fatal-error', { message });
  } finally {
    finishPublicRun(run);
  }
}

async function startTest(_event, rawSettings) {
  if (currentRun) {
    return { ok: false, error: 'Сначала остановите текущий тест.' };
  }

  let validated;
  try {
    validated = validateSettings(rawSettings);
    await saveSettings(validated);
  } catch (error) {
    return { ok: false, error: serializableError(error) };
  }

  const sessions = Array.from({ length: validated.sessionCount }, (_, index) => ({
    slotId: index + 1,
    cycle: 0,
    restartCount: 0,
    runId: '',
    durationSeconds: null,
    status: 'Ожидание',
    httpStatus: null,
    loadTimeMs: null,
    startedAt: '',
    errorText: ''
  }));
  const run = {
    settings: validated,
    sessions,
    browser: null,
    browserServer: null,
    contexts: new Set(),
    pages: new Set(),
    closingResources: new WeakSet(),
    workers: [],
    abortController: new AbortController(),
    stopping: null,
    completion: null,
    log: null,
    logPath: '',
    terminalEventSent: false,
    startedAtPerformance: performance.now(),
    metrics: {
      cyclesStarted: 0,
      cyclesCompleted: 0,
      cyclesSucceeded: 0,
      cyclesErrored: 0,
      restarted: 0,
      currentCycle: 0,
      loadTotalMs: 0,
      loadCount: 0
    }
  };
  run.log = createLogger(run);
  currentRun = run;
  publicState = {
    running: true,
    settings: { ...validated },
    sessions: clone(sessions),
    statistics: emptyStatistics(validated.sessionCount)
  };
  send('test-started', clone(publicState));
  run.completion = executeRun(run);
  void run.completion;
  return { ok: true, state: clone(publicState) };
}

async function stopCurrentTest() {
  const run = currentRun;
  if (!run) return { ok: true, alreadyStopped: true };
  if (run.stopping) return run.stopping;

  run.abortController.abort();
  run.stopping = (async () => {
    run.log('WARN', 'Получена команда остановки: новые циклы запрещены.');
    markUnfinishedSessionsStopped(run);
    await closeRunResources(run);
    const completion = run.completion
      ? await settleWithin(run.completion, STOP_COMPLETION_TIMEOUT_MS)
      : { timedOut: false };
    if (completion.timedOut) {
      run.log('ERROR', `Рабочие задачи не завершились за ${STOP_COMPLETION_TIMEOUT_MS} мс; состояние принудительно освобождено.`);
      finishPublicRun(run);
      sendTerminal(run, 'test-stopped', clone(publicState.statistics));
    }
    return { ok: true, forced: completion.timedOut };
  })();
  return run.stopping;
}

function registerIpc() {
  ipcMain.handle('start-test', startTest);
  ipcMain.handle('stop-test', stopCurrentTest);
  ipcMain.handle('get-test-state', () => clone(publicState));
  ipcMain.handle('open-logs-directory', async () => {
    await fsp.mkdir(logsDirectory, { recursive: true });
    const error = await shell.openPath(logsDirectory);
    return error ? { ok: false, error } : { ok: true };
  });
}

function createWindow() {
  const smokeMode = process.argv.includes('--smoke-test')
    || process.argv.includes('--cycle-smoke-test')
    || process.argv.includes('--stop-smoke-test');
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 760,
    show: !smokeMode,
    backgroundColor: '#0a0e17',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  mainWindow.on('close', async (event) => {
    if (!currentRun || closingConfirmed) return;
    event.preventDefault();
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Остановить тест и выйти', 'Отмена'],
      defaultId: 1,
      cancelId: 1,
      title: 'Тест ещё выполняется',
      message: 'Остановить активные браузерные сессии и закрыть приложение?'
    });
    if (result.response === 0) {
      closingConfirmed = true;
      await stopCurrentTest();
      mainWindow.destroy();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (process.argv.includes('--smoke-test')) {
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('SMOKE_TEST_OK');
      setTimeout(() => app.quit(), 250);
    });
  }
}

async function runCycleSmokeTest() {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Cycle smoke</title><p>OK</p>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    const result = await startTest(null, {
      ...DEFAULT_SETTINGS,
      url: `http://127.0.0.1:${address.port}/`,
      sessionCount: 2,
      durationSeconds: 10,
      launchDelayMs: 0,
      repeatEnabled: true,
      repeatMode: 'limited',
      maxCycles: 3,
      restartDelayMs: 0
    });
    if (!result.ok) throw new Error(result.error);

    const run = currentRun;
    await run.completion;
    const statistics = publicState.statistics;
    if (statistics.totalCycles !== 6
        || statistics.completed !== 6
        || statistics.restarted !== 4
        || statistics.errorCycles !== 0
        || statistics.currentCycle !== 3) {
      throw new Error(`Неожиданная статистика: ${JSON.stringify(statistics)}`);
    }
    console.log('CYCLE_SMOKE_TEST_OK');
  } catch (error) {
    process.exitCode = 1;
    throw error;
  } finally {
    await new Promise((resolve) => server.close(resolve));
    app.quit();
  }
}

async function runStopSmokeTest() {
  const server = http.createServer(() => {
    // Ответ намеренно не завершается: page.goto() остаётся активным до остановки.
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    const result = await startTest(null, {
      ...DEFAULT_SETTINGS,
      url: `http://127.0.0.1:${address.port}/`,
      sessionCount: 12,
      launchDelayMs: 0,
      navigationTimeoutMs: 300000,
      repeatEnabled: true,
      repeatMode: 'unlimited'
    });
    if (!result.ok) throw new Error(result.error);

    const loadingDeadline = performance.now() + 15000;
    while (performance.now() < loadingDeadline
        && currentRun
        && !currentRun.sessions.some((session) => session.status === 'Загрузка')) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const stopStarted = performance.now();
    const stopResult = await stopCurrentTest();
    const stopElapsedMs = Math.round(performance.now() - stopStarted);
    if (!stopResult.ok || currentRun || publicState.running || stopElapsedMs > 15000) {
      throw new Error(`Некорректная остановка: ${JSON.stringify({
        stopResult,
        hasCurrentRun: Boolean(currentRun),
        running: publicState.running,
        stopElapsedMs
      })}`);
    }
    console.log(`STOP_SMOKE_TEST_OK ${stopElapsedMs}ms`);
  } catch (error) {
    process.exitCode = 1;
    throw error;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    app.quit();
  }
}

process.on('unhandledRejection', (error) => {
  const message = serializableError(error);
  console.error('Необработанная ошибка Promise:', message);
  if (currentRun) currentRun.log('ERROR', `Необработанная ошибка Promise: ${message}`);
  send('fatal-error', { message });
});

process.on('uncaughtException', (error) => {
  const message = serializableError(error);
  console.error('Необработанная ошибка:', message);
  if (currentRun) currentRun.log('ERROR', `Необработанная ошибка: ${message}`);
  send('fatal-error', { message });
});

app.whenReady().then(async () => {
  await ensureDataDirectories();
  await loadSettings();
  registerIpc();
  createWindow();
  if (process.argv.includes('--cycle-smoke-test')) {
    await runCycleSmokeTest();
  } else if (process.argv.includes('--stop-smoke-test')) {
    await runStopSmokeTest();
  }
});

app.on('window-all-closed', async () => {
  if (currentRun) await stopCurrentTest();
  app.quit();
});

app.on('before-quit', () => {
  if (currentRun) currentRun.abortController.abort();
});
