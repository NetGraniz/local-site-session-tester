'use strict';

process.env.PLAYWRIGHT_BROWSERS_PATH = '0';

const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { chromium } = require('playwright');

const MAX_PARALLEL_SESSIONS = 50;
const DEFAULT_SETTINGS = Object.freeze({
  url: 'https://example.com',
  sessionCount: 5,
  durationSeconds: 15,
  launchDelayMs: 300,
  navigationTimeoutMs: 30000,
  headless: true,
  viewportWidth: 1280,
  viewportHeight: 720
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
    errors: 0,
    stopped: 0,
    averageLoadMs: 0
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
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
    settings = validateSettings(JSON.parse(raw));
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

  return {
    url: url.href,
    sessionCount: validateInteger(input.sessionCount, 'Количество сессий', 1, MAX_PARALLEL_SESSIONS),
    durationSeconds: validateInteger(input.durationSeconds, 'Продолжительность', 0, 86400),
    launchDelayMs: validateInteger(input.launchDelayMs, 'Задержка запуска', 0, 60000),
    navigationTimeoutMs: validateInteger(input.navigationTimeoutMs, 'Тайм-аут загрузки', 1000, 300000),
    headless: input.headless !== false,
    viewportWidth: validateInteger(input.viewportWidth, 'Ширина окна', 320, 7680),
    viewportHeight: validateInteger(input.viewportHeight, 'Высота окна', 240, 4320)
  };
}

function calculateStatistics(run) {
  const sessions = run.sessions;
  const loaded = sessions.filter((session) => Number.isFinite(session.loadTimeMs));
  const averageLoadMs = loaded.length
    ? Math.round(loaded.reduce((sum, session) => sum + session.loadTimeMs, 0) / loaded.length)
    : 0;

  return {
    planned: sessions.length,
    started: sessions.filter((session) => session.startedAt).length,
    active: sessions.filter((session) => ['Запуск', 'Загрузка', 'Активно'].includes(session.status)).length,
    completed: sessions.filter((session) => session.status === 'Завершено').length,
    errors: sessions.filter((session) => session.status === 'Ошибка').length,
    stopped: sessions.filter((session) => session.status === 'Остановлено').length,
    averageLoadMs
  };
}

function publishStatistics(run) {
  publicState.statistics = calculateStatistics(run);
  send('statistics-updated', clone(publicState.statistics));
}

function publishSession(run, session) {
  if (currentRun !== run) return;
  publicState.sessions[session.number - 1] = clone(session);
  send('session-updated', clone(session));
  publishStatistics(run);
}

function updateSession(run, session, patch) {
  Object.assign(session, patch);
  publishSession(run, session);
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

function cancellableDelay(run, milliseconds) {
  if (run.cancelled || milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const token = { timer: null, resolve };
    token.timer = setTimeout(() => {
      run.delays.delete(token);
      resolve();
    }, milliseconds);
    run.delays.add(token);
  });
}

function cancelDelays(run) {
  for (const token of run.delays) {
    clearTimeout(token.timer);
    token.resolve();
  }
  run.delays.clear();
}

function resolveBrowserExecutable() {
  const expected = chromium.executablePath();
  if (!app.isPackaged || !expected.includes('app.asar')) return expected;
  const unpacked = expected.replace('app.asar', 'app.asar.unpacked');
  return fs.existsSync(unpacked) ? unpacked : expected;
}

async function runOneSession(run, session) {
  let context = null;
  let page = null;

  try {
    if (run.cancelled) {
      updateSession(run, session, { status: 'Остановлено', errorText: 'Остановлено пользователем' });
      return;
    }

    updateSession(run, session, {
      status: 'Запуск',
      startedAt: formatDate()
    });
    run.log('INFO', `Сессия ${session.number}: запуск.`);

    context = await run.browser.newContext({
      viewport: {
        width: run.settings.viewportWidth,
        height: run.settings.viewportHeight
      }
    });
    run.contexts.add(context);

    if (run.cancelled) throw new Error('Тест остановлен пользователем');

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

    if (run.cancelled) throw new Error('Тест остановлен пользователем');

    if (httpStatus !== null && httpStatus >= 400) {
      const statusText = response.statusText() || 'Ошибка HTTP';
      const errorText = `HTTP ${httpStatus} ${statusText}`.trim();
      updateSession(run, session, {
        status: 'Ошибка',
        httpStatus,
        loadTimeMs,
        errorText
      });
      run.log('WARN', `Сессия ${session.number}: сервер вернул ${errorText}, загрузка ${loadTimeMs} мс.`);
      return;
    }

    updateSession(run, session, {
      status: 'Активно',
      httpStatus,
      loadTimeMs,
      errorText: ''
    });
    run.log('INFO', `Сессия ${session.number}: страница загружена за ${loadTimeMs} мс, HTTP ${httpStatus ?? 'нет ответа'}.`);

    await cancellableDelay(run, run.settings.durationSeconds * 1000);
    if (run.cancelled) throw new Error('Тест остановлен пользователем');

    updateSession(run, session, { status: 'Завершено' });
    run.log('INFO', `Сессия ${session.number}: завершена.`);
  } catch (error) {
    if (run.cancelled) {
      updateSession(run, session, {
        status: 'Остановлено',
        errorText: 'Остановлено пользователем'
      });
      run.log('WARN', `Сессия ${session.number}: остановлена пользователем.`);
    } else {
      const message = serializableError(error);
      updateSession(run, session, {
        status: 'Ошибка',
        errorText: message
      });
      run.log('ERROR', `Сессия ${session.number}: ${message}`);
    }
  } finally {
    if (page) {
      run.pages.delete(page);
      await page.close().catch(() => {});
    }
    if (context) {
      run.contexts.delete(context);
      await context.close().catch(() => {});
    }
  }
}

async function closeRunResources(run) {
  cancelDelays(run);
  const pages = [...run.pages];
  const contexts = [...run.contexts];
  run.pages.clear();
  run.contexts.clear();
  await Promise.allSettled(pages.map((page) => page.close()));
  await Promise.allSettled(contexts.map((context) => context.close()));
  if (run.browser) {
    const browser = run.browser;
    run.browser = null;
    await browser.close().catch(() => {});
  }
}

async function executeRun(run) {
  try {
    run.log('INFO', `Тест начат: ${run.settings.sessionCount} сессий, адрес ${run.settings.url}.`);
    run.browser = await chromium.launch({
      headless: run.settings.headless,
      executablePath: resolveBrowserExecutable()
    });

    for (let index = 0; index < run.sessions.length; index += 1) {
      if (run.cancelled) break;
      if (index > 0) await cancellableDelay(run, run.settings.launchDelayMs);
      if (run.cancelled) break;
      const task = runOneSession(run, run.sessions[index]);
      run.tasks.add(task);
      task.finally(() => run.tasks.delete(task));
    }

    if (run.cancelled) {
      for (const session of run.sessions) {
        if (session.status === 'Ожидание') {
          updateSession(run, session, {
            status: 'Остановлено',
            errorText: 'Не запущено: тест остановлен'
          });
        }
      }
    }

    await Promise.allSettled([...run.tasks]);
    await closeRunResources(run);

    if (run.cancelled) {
      run.log('WARN', 'Тест остановлен пользователем.');
      send('test-stopped', clone(calculateStatistics(run)));
    } else {
      run.log('INFO', 'Все сессии завершены.');
      send('test-finished', clone(calculateStatistics(run)));
    }
  } catch (error) {
    const message = serializableError(error);
    run.log('ERROR', `Критическая ошибка: ${message}`);
    for (const session of run.sessions) {
      if (!['Завершено', 'Ошибка', 'Остановлено'].includes(session.status)) {
        updateSession(run, session, {
          status: run.cancelled ? 'Остановлено' : 'Ошибка',
          errorText: run.cancelled ? 'Остановлено пользователем' : message
        });
      }
    }
    await closeRunResources(run);
    if (!run.cancelled) send('fatal-error', { message });
  } finally {
    if (currentRun === run) {
      publicState.running = false;
      publicState.sessions = clone(run.sessions);
      publicState.statistics = calculateStatistics(run);
      currentRun = null;
    }
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
    number: index + 1,
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
    contexts: new Set(),
    pages: new Set(),
    tasks: new Set(),
    delays: new Set(),
    cancelled: false,
    stopping: null,
    completion: null,
    log: null,
    logPath: ''
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

  run.cancelled = true;
  run.stopping = (async () => {
    run.log('WARN', 'Получена команда остановки.');
    cancelDelays(run);
    await closeRunResources(run);
    if (run.completion) await run.completion;
    return { ok: true };
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
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 980,
    minHeight: 720,
    show: !process.argv.includes('--smoke-test'),
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
});

app.on('window-all-closed', async () => {
  if (currentRun) await stopCurrentTest();
  app.quit();
});

app.on('before-quit', () => {
  if (currentRun) {
    currentRun.cancelled = true;
    cancelDelays(currentRun);
  }
});
