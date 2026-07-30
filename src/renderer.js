'use strict';

const api = window.localVisitor;
const form = document.querySelector('#testForm');
const startButton = document.querySelector('#startButton');
const stopButton = document.querySelector('#stopButton');
const clearLogButton = document.querySelector('#clearLogButton');
const openLogsButton = document.querySelector('#openLogsButton');
const validationMessage = document.querySelector('#validationMessage');
const runState = document.querySelector('#runState');
const runStateText = document.querySelector('#runStateText');
const sessionRows = document.querySelector('#sessionRows');
const recordCount = document.querySelector('#recordCount');
const logOutput = document.querySelector('#logOutput');
const repeatOptions = document.querySelector('#repeatOptions');
const maxCyclesField = document.querySelector('#maxCyclesField');
const infiniteWarning = document.querySelector('#infiniteWarning');
const durationFixedField = document.querySelector('#durationFixedField');
const durationMinField = document.querySelector('#durationMinField');
const durationMaxField = document.querySelector('#durationMaxField');
const fields = [...form.querySelectorAll('input, select')];

let isRunning = false;

const elements = {
  url: document.querySelector('#url'),
  sessionCount: document.querySelector('#sessionCount'),
  durationMode: document.querySelector('#durationMode'),
  durationSeconds: document.querySelector('#durationSeconds'),
  minDurationSeconds: document.querySelector('#minDurationSeconds'),
  maxDurationSeconds: document.querySelector('#maxDurationSeconds'),
  launchDelayMs: document.querySelector('#launchDelayMs'),
  navigationTimeoutMs: document.querySelector('#navigationTimeoutMs'),
  headless: document.querySelector('#headless'),
  viewportWidth: document.querySelector('#viewportWidth'),
  viewportHeight: document.querySelector('#viewportHeight'),
  repeatEnabled: document.querySelector('#repeatEnabled'),
  repeatMode: document.querySelector('#repeatMode'),
  maxCycles: document.querySelector('#maxCycles'),
  restartDelayMs: document.querySelector('#restartDelayMs'),
  stopSlotOnError: document.querySelector('#stopSlotOnError')
};

const statElements = {
  planned: document.querySelector('#statPlanned'),
  started: document.querySelector('#statStarted'),
  active: document.querySelector('#statActive'),
  completed: document.querySelector('#statCompleted'),
  stopped: document.querySelector('#statStopped'),
  averageLoadMs: document.querySelector('#statAverage'),
  totalCycles: document.querySelector('#statTotalCycles'),
  currentCycle: document.querySelector('#statCurrentCycle'),
  restarted: document.querySelector('#statRestarted'),
  errorCycles: document.querySelector('#statErrorCycles'),
  cyclesPerMinute: document.querySelector('#statCyclesPerMinute')
};

const sessions = new Map();

function updateDurationControls() {
  const rangeMode = elements.durationMode.value === 'range';
  durationFixedField.hidden = rangeMode;
  durationMinField.hidden = !rangeMode;
  durationMaxField.hidden = !rangeMode;

  if (!isRunning) {
    elements.durationSeconds.disabled = rangeMode;
    elements.minDurationSeconds.disabled = !rangeMode;
    elements.maxDurationSeconds.disabled = !rangeMode;
  }
}

function updateRepeatControls() {
  const repeatEnabled = elements.repeatEnabled.checked;
  const limited = repeatEnabled && elements.repeatMode.value === 'limited';
  repeatOptions.hidden = !repeatEnabled;
  maxCyclesField.hidden = !limited;
  infiniteWarning.hidden = !(repeatEnabled && elements.repeatMode.value === 'unlimited');

  if (!isRunning) {
    elements.repeatMode.disabled = !repeatEnabled;
    elements.restartDelayMs.disabled = !repeatEnabled;
    elements.stopSlotOnError.disabled = !repeatEnabled;
    elements.maxCycles.disabled = !limited;
  }
}

function setRunning(running, label) {
  isRunning = running;
  fields.forEach((field) => {
    field.disabled = running;
  });
  startButton.disabled = running;
  stopButton.disabled = !running;
  runState.classList.toggle('is-active', running);
  runStateText.textContent = label || (running ? 'Тест выполняется' : 'Готово к запуску');
  if (!running) {
    updateDurationControls();
    updateRepeatControls();
  }
}

function showValidation(message) {
  validationMessage.textContent = message;
  validationMessage.hidden = !message;
}

function populateSettings(settings) {
  for (const [key, element] of Object.entries(elements)) {
    if (element.type === 'checkbox') {
      element.checked = Boolean(settings[key]);
    } else if (key === 'headless') {
      element.value = String(settings[key]);
    } else {
      element.value = settings[key] ?? '';
    }
  }
  updateDurationControls();
  updateRepeatControls();
}

function collectSettings() {
  return {
    url: elements.url.value.trim(),
    sessionCount: Number(elements.sessionCount.value),
    durationMode: elements.durationMode.value,
    durationSeconds: Number(elements.durationSeconds.value),
    minDurationSeconds: Number(elements.minDurationSeconds.value),
    maxDurationSeconds: Number(elements.maxDurationSeconds.value),
    launchDelayMs: Number(elements.launchDelayMs.value),
    navigationTimeoutMs: Number(elements.navigationTimeoutMs.value),
    headless: elements.headless.value === 'true',
    viewportWidth: Number(elements.viewportWidth.value),
    viewportHeight: Number(elements.viewportHeight.value),
    repeatEnabled: elements.repeatEnabled.checked,
    repeatMode: elements.repeatMode.value,
    maxCycles: Number(elements.maxCycles.value),
    restartDelayMs: Number(elements.restartDelayMs.value),
    stopSlotOnError: elements.stopSlotOnError.checked
  };
}

function validateLocally(settings) {
  let parsed;
  try {
    parsed = new URL(settings.url);
  } catch {
    return 'Введите корректный URL сайта.';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return 'Разрешены только адреса с http:// или https://.';
  }
  if (!form.checkValidity()) {
    form.reportValidity();
    return 'Проверьте числовые параметры теста.';
  }
  if (settings.durationMode === 'range' && settings.maxDurationSeconds < settings.minDurationSeconds) {
    return 'Максимальная длительность не может быть меньше минимальной.';
  }
  if (settings.repeatEnabled && settings.repeatMode === 'limited'
      && (!Number.isInteger(settings.maxCycles) || settings.maxCycles < 1 || settings.maxCycles > 100000)) {
    return 'Количество циклов на слот должно быть от 1 до 100000.';
  }
  return '';
}

function statusClass(status) {
  const classes = {
    'Ожидание': 'status-waiting',
    'Запуск': 'status-starting',
    'Загрузка': 'status-loading',
    'Активно': 'status-active',
    'Завершено': 'status-completed',
    'Ошибка': 'status-error',
    'Остановлено': 'status-stopped'
  };
  return classes[status] || 'status-waiting';
}

function createCell(text, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function renderSessions() {
  sessionRows.replaceChildren();
  const ordered = [...sessions.values()].sort((a, b) => a.slotId - b.slotId);
  recordCount.textContent = `${ordered.length} ${ordered.length === 1 ? 'слот' : ordered.length < 5 ? 'слота' : 'слотов'}`;

  if (!ordered.length) {
    const row = document.createElement('tr');
    row.className = 'empty-row';
    const cell = createCell('Сессии появятся после запуска теста');
    cell.colSpan = 10;
    row.append(cell);
    sessionRows.append(row);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const session of ordered) {
    const row = document.createElement('tr');
    const statusCell = document.createElement('td');
    const badge = document.createElement('span');
    badge.className = `status-badge ${statusClass(session.status)}`;
    badge.textContent = session.status;
    statusCell.append(badge);
    row.append(
      createCell(String(session.slotId), 'session-number'),
      createCell(session.cycle || '—', 'mono'),
      createCell(session.runId || '—', 'mono run-id'),
      createCell(String(session.restartCount || 0), 'mono'),
      createCell(session.durationSeconds ? `${session.durationSeconds} сек` : '—', 'mono'),
      statusCell,
      createCell(session.httpStatus ?? '—', 'mono'),
      createCell(session.loadTimeMs === null ? '—' : `${session.loadTimeMs} мс`, 'mono'),
      createCell(session.startedAt || '—', 'mono'),
      createCell(session.errorText || '—', session.errorText ? 'error-text' : 'muted-text')
    );
    fragment.append(row);
  }
  sessionRows.append(fragment);
}

function renderStatistics(statistics) {
  for (const [key, element] of Object.entries(statElements)) {
    element.textContent = statistics[key] ?? 0;
  }
}

function appendLog(entry) {
  const placeholder = logOutput.querySelector('.log-placeholder');
  if (placeholder) placeholder.remove();
  const line = document.createElement('p');
  line.className = `log-line log-${String(entry.level).toLowerCase()}`;

  const time = document.createElement('span');
  time.className = 'log-time';
  time.textContent = entry.timestamp;
  const level = document.createElement('span');
  level.className = 'log-level';
  level.textContent = entry.level;
  const message = document.createElement('span');
  message.className = 'log-message';
  message.textContent = entry.message;

  line.append(time, level, message);
  logOutput.append(line);
  while (logOutput.children.length > 1000) logOutput.firstElementChild.remove();
  logOutput.scrollTop = logOutput.scrollHeight;
}

function loadState(state) {
  populateSettings(state.settings);
  sessions.clear();
  for (const session of state.sessions || []) sessions.set(session.slotId, session);
  renderSessions();
  renderStatistics(state.statistics || {});
  setRunning(Boolean(state.running));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showValidation('');
  const settings = collectSettings();
  const localError = validateLocally(settings);
  if (localError) {
    showValidation(localError);
    return;
  }

  startButton.disabled = true;
  try {
    const result = await api.startTest(settings);
    if (!result.ok) {
      showValidation(result.error);
      setRunning(false);
    }
  } catch (error) {
    showValidation(`Не удалось запустить тест: ${error.message}`);
    setRunning(false);
  }
});

stopButton.addEventListener('click', async () => {
  stopButton.disabled = true;
  runStateText.textContent = 'Остановка…';
  try {
    const result = await api.stopTest();
    if (!result.ok) showValidation(result.error || 'Не удалось остановить тест.');
  } catch (error) {
    showValidation(`Ошибка остановки: ${error.message}`);
    stopButton.disabled = false;
  }
});

clearLogButton.addEventListener('click', () => {
  logOutput.replaceChildren();
  const placeholder = document.createElement('p');
  placeholder.className = 'log-placeholder';
  placeholder.textContent = 'Журнал очищен в интерфейсе. Файл на диске сохранён.';
  logOutput.append(placeholder);
});

openLogsButton.addEventListener('click', async () => {
  showValidation('');
  const result = await api.openLogsDirectory();
  if (!result.ok) showValidation(`Не удалось открыть папку журналов: ${result.error}`);
});

elements.repeatEnabled.addEventListener('change', updateRepeatControls);
elements.repeatMode.addEventListener('change', updateRepeatControls);
elements.durationMode.addEventListener('change', updateDurationControls);

api.on('test-started', (state) => {
  sessions.clear();
  for (const session of state.sessions) sessions.set(session.slotId, session);
  renderSessions();
  renderStatistics(state.statistics);
  setRunning(true);
  showValidation('');
});

api.on('session-updated', (session) => {
  sessions.set(session.slotId, session);
  renderSessions();
});

api.on('statistics-updated', renderStatistics);
api.on('log-message', appendLog);

api.on('test-finished', (statistics) => {
  renderStatistics(statistics);
  setRunning(false, 'Тест завершён');
});

api.on('test-stopped', (statistics) => {
  renderStatistics(statistics);
  setRunning(false, 'Тест остановлен');
});

api.on('fatal-error', ({ message }) => {
  showValidation(`Критическая ошибка: ${message}`);
  setRunning(false, 'Ошибка выполнения');
});

api.getTestState()
  .then(loadState)
  .catch((error) => showValidation(`Не удалось получить состояние: ${error.message}`));
