'use strict';

const crypto = require('node:crypto');
const { abortableDelay } = require('./scheduler');

const AUTO_CANDIDATE_SELECTORS = Object.freeze([
  'nav a[href]',
  'main a[href]',
  '[role="navigation"] a[href]',
  'button:not([type="submit"])',
  '[role="button"]'
]);

const MANDATORY_BLOCKED_SELECTORS = Object.freeze([
  'button[type="submit"]',
  'input[type="submit"]',
  'input[type="image"]',
  'input[type="file"]',
  'a[target="_blank"]',
  'a[download]',
  '[data-danger]',
  '.danger',
  '.delete',
  '.logout',
  '.signout',
  '.payment',
  '.checkout',
  '.admin',
  '[aria-haspopup="dialog"][aria-label*="delete" i]',
  '[aria-haspopup="dialog"][aria-label*="удал" i]'
]);

const MANDATORY_BLOCKED_TEXT_PATTERN =
  /удалить|оплатить|купить|заказать|выйти|выход|отправить|подтвердить|бан|блокировать|delete|remove|purchase|checkout|pay|logout|sign out|submit|confirm/i;

const BLOCKED_PROTOCOLS = new Set(['mailto:', 'tel:', 'javascript:', 'data:', 'file:']);
const MAX_CANDIDATES_PER_SELECTOR = 50;
const MAX_TOTAL_CANDIDATES = 200;

function createAbortError() {
  const error = new Error('Операция отменена');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(abortSignal) {
  if (abortSignal.aborted) throw createAbortError();
}

function createDeadlineError() {
  const error = new Error('Время цикла истекло');
  error.name = 'DeadlineError';
  return error;
}

function throwIfDeadlineReached(deadlineAt) {
  if (performance.now() >= deadlineAt) throw createDeadlineError();
}

function parseLineList(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeSeed(seed) {
  const numeric = Number(seed);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 0xffffffff) {
    throw new Error('Seed должен быть целым числом от 0 до 4294967295.');
  }
  return numeric >>> 0;
}

function generateSeed(configuredSeed) {
  if (configuredSeed !== null && configuredSeed !== undefined && configuredSeed !== '') {
    return normalizeSeed(configuredSeed);
  }
  return crypto.randomInt(0, 0x100000000);
}

function createSeededRandom(seed) {
  let state = normalizeSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function randomInteger(random, min, maxInclusive) {
  return min + Math.floor(random() * (maxInclusive - min + 1));
}

function chooseRandom(random, values) {
  return values[Math.floor(random() * values.length)];
}

function truncateText(value, maxLength = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    const sensitiveKey = /token|auth|secret|password|passwd|session|cookie|jwt|signature|credential|api[-_]?key|code|state/i;
    for (const [key, parameterValue] of parsed.searchParams) {
      parsed.searchParams.set(
        key,
        sensitiveKey.test(key) || sensitiveKey.test(parameterValue)
          ? '[redacted]'
          : truncateText(parameterValue, 80)
      );
    }
    if (parsed.hash && (parsed.hash.length > 160 || sensitiveKey.test(parsed.hash))) {
      parsed.hash = '#[redacted]';
    }
    return `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '';
  }
}

async function validSelectors(page, selectors, abortSignal) {
  const validated = [];
  for (const selector of selectors) {
    throwIfAborted(abortSignal);
    try {
      const valid = await page.evaluate((candidate) => {
        try {
          document.querySelector(candidate);
          return true;
        } catch {
          return false;
        }
      }, selector);
      if (valid) validated.push(selector);
    } catch {
      // Страница могла смениться между проверками. Такой селектор пропускается.
    }
  }
  return validated;
}

async function assertBlockedSelectorsValid(page, selectors, abortSignal) {
  for (const selector of selectors) {
    throwIfAborted(abortSignal);
    const valid = await page.evaluate((candidate) => {
      try {
        document.querySelector(candidate);
        return true;
      } catch {
        return false;
      }
    }, selector).catch(() => false);
    if (!valid) {
      throw new Error(`Некорректный запрещённый CSS-селектор: ${truncateText(selector, 120)}`);
    }
  }
}

async function inspectCandidate(locator, selector, options, abortSignal) {
  throwIfAborted(abortSignal);
  if (!await locator.isVisible().catch(() => false)) return { safe: false, dangerous: false };
  throwIfAborted(abortSignal);
  if (!await locator.isEnabled().catch(() => false)) return { safe: false, dangerous: false };
  throwIfAborted(abortSignal);

  return locator.evaluate((element, payload) => {
    const {
      allowedOrigin,
      blockedSelectors,
      blockedWords,
      mandatoryBlockedSelectors,
      mandatoryBlockedTextSource,
      mandatoryBlockedTextFlags,
      blockedProtocols
    } = payload;
    const ariaLabel = String(element.getAttribute('aria-label') || '');
    const visibleText = String(element.innerText || element.textContent || '');
    const safetyText = `${ariaLabel} ${visibleText}`.replace(/\s+/g, ' ').trim().slice(0, 20000);
    const text = (ariaLabel || visibleText).replace(/\s+/g, ' ').trim().slice(0, 240);
    const normalizedText = safetyText.toLocaleLowerCase('ru-RU');
    const mandatoryText = new RegExp(mandatoryBlockedTextSource, mandatoryBlockedTextFlags);
    const allBlockedSelectors = [...mandatoryBlockedSelectors, ...blockedSelectors];
    const selectorBlocked = allBlockedSelectors.some((blockedSelector) => {
      try {
        return element.matches(blockedSelector) || Boolean(element.closest(blockedSelector));
      } catch {
        return false;
      }
    });
    const textBlocked = mandatoryText.test(safetyText)
      || blockedWords.some((word) => normalizedText.includes(word));
    const formBlocked = Boolean(element.closest('form'));
    const submitCapable = element.tagName.toLowerCase() === 'button' && element.type === 'submit';
    const disabled = element.hasAttribute('disabled')
      || element.getAttribute('aria-disabled') === 'true'
      || Boolean(element.closest('[inert]'))
      || getComputedStyle(element).pointerEvents === 'none';
    if (selectorBlocked || textBlocked || formBlocked || submitCapable || disabled) {
      return { safe: false, dangerous: true, text };
    }

    const tagName = element.tagName.toLowerCase();
    const role = String(element.getAttribute('role') || '').toLowerCase();
    const isLink = tagName === 'a' && element.hasAttribute('href');
    const isButton = tagName === 'button' || role === 'button';
    if (!isLink && !isButton) return { safe: false, dangerous: false, text };

    let targetUrl = '';
    if (isLink) {
      const href = element.getAttribute('href') || '';
      try {
        const parsed = new URL(href, document.location.href);
        if (blockedProtocols.includes(parsed.protocol) || parsed.origin !== allowedOrigin) {
          return { safe: false, dangerous: true, text };
        }
        targetUrl = parsed.href;
      } catch {
        return { safe: false, dangerous: true, text };
      }
    }

    return {
      safe: true,
      dangerous: false,
      kind: isLink ? 'link' : 'button',
      selector: payload.selector,
      text,
      targetUrl
    };
  }, {
    allowedOrigin: options.allowedOrigin,
    blockedSelectors: options.blockedSelectors,
    blockedWords: options.blockedWords,
    mandatoryBlockedSelectors: MANDATORY_BLOCKED_SELECTORS,
    mandatoryBlockedTextSource: MANDATORY_BLOCKED_TEXT_PATTERN.source,
    mandatoryBlockedTextFlags: MANDATORY_BLOCKED_TEXT_PATTERN.flags,
    blockedProtocols: [...BLOCKED_PROTOCOLS],
    selector
  }).catch(() => ({ safe: false, dangerous: false }));
}

async function collectSafeCandidates(page, options, abortSignal, selectorsOverride = null) {
  throwIfAborted(abortSignal);
  await assertBlockedSelectorsValid(page, [
    ...MANDATORY_BLOCKED_SELECTORS,
    ...options.blockedSelectors
  ], abortSignal);
  const configuredSelectors = selectorsOverride || [
    ...options.allowedSelectors,
    ...(options.autoDiscoverSafeElements ? AUTO_CANDIDATE_SELECTORS : [])
  ];
  const selectors = await validSelectors(page, [...new Set(configuredSelectors)], abortSignal);
  const links = [];
  const buttons = [];
  const seen = new Set();
  let dangerousSkipped = 0;
  let totalInspected = 0;

  for (const selector of selectors) {
    throwIfAborted(abortSignal);
    const candidates = page.locator(selector);
    const count = Math.min(
      await candidates.count().catch(() => 0),
      MAX_CANDIDATES_PER_SELECTOR
    );
    for (let index = 0; index < count && totalInspected < MAX_TOTAL_CANDIDATES; index += 1) {
      throwIfAborted(abortSignal);
      totalInspected += 1;
      const locator = candidates.nth(index);
      const inspection = await inspectCandidate(locator, selector, options, abortSignal);
      if (inspection.dangerous) {
        dangerousSkipped += 1;
        continue;
      }
      if (!inspection.safe) continue;
      const key = `${inspection.kind}|${inspection.targetUrl}|${inspection.text}|${selector}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const candidate = { locator, ...inspection };
      if (inspection.kind === 'link') links.push(candidate);
      if (inspection.kind === 'button') buttons.push(candidate);
    }
  }

  return { links, buttons, dangerousSkipped };
}

async function pageFingerprint(page) {
  return page.evaluate(() => {
    const text = String(document.body?.innerText || '').slice(0, 4000);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${document.location.href}|${document.title}|${text.length}|${hash >>> 0}`;
  }).catch(() => '');
}

async function waitForPageChange(
  page,
  beforeUrl,
  beforeFingerprint,
  timeoutMs,
  abortSignal,
  actionDeadlineAt
) {
  const deadline = Math.min(
    performance.now() + Math.min(timeoutMs, 2500),
    actionDeadlineAt
  );
  while (performance.now() < deadline) {
    throwIfAborted(abortSignal);
    const currentUrl = page.url();
    const currentFingerprint = await pageFingerprint(page);
    if (currentUrl !== beforeUrl || currentFingerprint !== beforeFingerprint) return true;
    await abortableDelay(100, abortSignal);
  }
  return false;
}

async function getScrollState(page) {
  return page.evaluate(() => {
    const root = document.scrollingElement || document.documentElement;
    const maxY = Math.max(0, root.scrollHeight - window.innerHeight);
    return { y: Math.max(0, window.scrollY), maxY };
  }).catch(() => ({ y: 0, maxY: 0 }));
}

function actionTitle(type) {
  return {
    navigate: 'переход',
    click: 'нажатие',
    scroll: 'прокрутка',
    back: 'возврат назад'
  }[type] || type;
}

async function executeAction({
  action,
  page,
  candidate,
  random,
  navigationDepth,
  options,
  abortSignal,
  deadlineAt
}) {
  throwIfAborted(abortSignal);
  throwIfDeadlineReached(deadlineAt);
  const started = performance.now();
  const urlBefore = safeUrl(page.url());
  let selector = candidate?.selector || '';
  let text = truncateText(candidate?.text || '');
  let nextDepth = navigationDepth;
  let result = 'выполнено';
  let success = true;

  if (action === 'navigate') {
    const reinspection = await inspectCandidate(candidate.locator, candidate.selector, options, abortSignal);
    if (!reinspection.safe || reinspection.kind !== 'link') {
      throw new Error('Элемент больше не проходит безопасную проверку.');
    }
    const beforeRawUrl = page.url();
    const beforeFingerprint = await pageFingerprint(page);
    await candidate.locator.scrollIntoViewIfNeeded({ timeout: options.actionTimeoutMs });
    throwIfAborted(abortSignal);
    throwIfDeadlineReached(deadlineAt);
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: options.actionTimeoutMs }).catch(() => {}),
      candidate.locator.click({ timeout: options.actionTimeoutMs })
    ]);
    const changed = await waitForPageChange(
      page,
      beforeRawUrl,
      beforeFingerprint,
      options.actionTimeoutMs,
      abortSignal,
      deadlineAt
    );
    if (!changed) {
      success = false;
      result = 'URL и содержимое страницы не изменились';
    } else {
      nextDepth = Math.min(navigationDepth + 1, options.maxNavigationDepth);
    }
  } else if (action === 'click') {
    const reinspection = await inspectCandidate(candidate.locator, candidate.selector, options, abortSignal);
    if (!reinspection.safe || reinspection.kind !== 'button') {
      throw new Error('Элемент больше не проходит безопасную проверку.');
    }
    const beforeRawUrl = page.url();
    await candidate.locator.scrollIntoViewIfNeeded({ timeout: options.actionTimeoutMs });
    throwIfAborted(abortSignal);
    throwIfDeadlineReached(deadlineAt);
    await candidate.locator.click({ timeout: options.actionTimeoutMs });
    await page.waitForLoadState('domcontentloaded', { timeout: options.actionTimeoutMs }).catch(() => {});
    if (page.url() !== beforeRawUrl) {
      nextDepth = Math.min(navigationDepth + 1, options.maxNavigationDepth);
    }
  } else if (action === 'scroll') {
    selector = 'window';
    const before = await getScrollState(page);
    const directions = [];
    if (before.y < before.maxY - 1) directions.push(1);
    if (before.y > 1) directions.push(-1);
    if (!directions.length) {
      success = false;
      result = 'страница не прокручивается';
    } else {
      const preferred = random() < 0.8 ? 1 : -1;
      const direction = directions.includes(preferred) ? preferred : directions[0];
      const available = direction > 0 ? before.maxY - before.y : before.y;
      const distance = Math.min(randomInteger(random, 250, 900), Math.max(1, Math.floor(available)));
      text = `${direction > 0 ? 'вниз' : 'вверх'} на ${distance} px`;
      throwIfAborted(abortSignal);
      throwIfDeadlineReached(deadlineAt);
      await page.mouse.wheel(0, distance * direction);
    }
  } else if (action === 'back') {
    selector = 'history.back';
    const beforeRawUrl = page.url();
    throwIfAborted(abortSignal);
    throwIfDeadlineReached(deadlineAt);
    await page.goBack({
      waitUntil: 'domcontentloaded',
      timeout: options.actionTimeoutMs
    }).catch(() => null);
    if (page.url() === beforeRawUrl) {
      success = false;
      result = 'история страницы не изменилась';
    } else {
      nextDepth = Math.max(0, navigationDepth - 1);
    }
  }

  const urlAfter = safeUrl(page.url());
  return {
    type: action,
    title: actionTitle(action),
    selector,
    text,
    urlBefore,
    urlAfter,
    result,
    success,
    durationMs: Math.round(performance.now() - started),
    navigationDepth: nextDepth
  };
}

async function performRandomActions({
  page,
  settings,
  abortSignal,
  seed,
  deadlineAt = Infinity,
  onAction = () => {},
  onDangerousSkipped = () => {}
}) {
  throwIfAborted(abortSignal);
  const actualSeed = generateSeed(seed);
  const random = createSeededRandom(actualSeed);
  const allowedOrigin = new URL(settings.url).origin;
  const options = {
    ...settings,
    allowedOrigin,
    allowedSelectors: parseLineList(settings.allowedSelectors),
    blockedSelectors: parseLineList(settings.blockedSelectors),
    blockedWords: parseLineList(settings.blockedActionWords)
      .map((word) => word.toLocaleLowerCase('ru-RU'))
  };
  const total = randomInteger(random, settings.randomActionsMin, settings.randomActionsMax);
  let completed = 0;
  let navigationDepth = 0;

  for (let index = 1; index <= total; index += 1) {
    throwIfAborted(abortSignal);
    if (performance.now() >= deadlineAt) break;

    const candidates = await collectSafeCandidates(page, options, abortSignal);
    if (candidates.dangerousSkipped > 0) onDangerousSkipped(candidates.dangerousSkipped);
    if (performance.now() >= deadlineAt) break;
    const availableActions = [];
    if (settings.allowInternalNavigation
        && navigationDepth < settings.maxNavigationDepth
        && candidates.links.length > 0) {
      availableActions.push('navigate');
    }
    if (settings.allowButtonClicks && candidates.buttons.length > 0) {
      availableActions.push('click');
    }
    if (settings.allowScrolling) {
      const scroll = await getScrollState(page);
      if (scroll.maxY > 1) availableActions.push('scroll');
    }
    if (settings.allowGoBack && navigationDepth > 0 && page.url() !== settings.url) {
      availableActions.push('back');
    }
    if (!availableActions.length) break;

    const action = chooseRandom(random, availableActions);
    const candidate = action === 'navigate'
      ? chooseRandom(random, candidates.links)
      : action === 'click'
        ? chooseRandom(random, candidates.buttons)
        : null;
    let event;
    const attemptStarted = performance.now();
    const attemptUrlBefore = safeUrl(page.url());
    try {
      event = await executeAction({
        action,
        page,
        candidate,
        random,
        navigationDepth,
        options: {
          ...options,
          actionTimeoutMs: Math.max(
            1,
            Math.min(options.actionTimeoutMs, deadlineAt - performance.now())
          )
        },
        abortSignal,
        deadlineAt
      });
      navigationDepth = event.navigationDepth;
    } catch (error) {
      if (abortSignal.aborted || error.name === 'AbortError') throw createAbortError();
      if (error.name === 'DeadlineError') break;
      event = {
        type: action,
        title: actionTitle(action),
        selector: candidate?.selector || '',
        text: truncateText(candidate?.text || ''),
        urlBefore: attemptUrlBefore,
        urlAfter: safeUrl(page.url()),
        result: truncateText(error.message || error, 140),
        success: false,
        durationMs: Math.round(performance.now() - attemptStarted),
        navigationDepth
      };
    }
    completed += 1;
    await onAction({ ...event, index, total, seed: actualSeed });

    if (index < total && performance.now() < deadlineAt) {
      const delay = randomInteger(random, settings.actionDelayMinMs, settings.actionDelayMaxMs);
      const remaining = deadlineAt - performance.now();
      if (remaining <= 0) break;
      await abortableDelay(Math.min(delay, remaining), abortSignal);
    }
  }

  return { seed: actualSeed, planned: total, completed, navigationDepth };
}

async function performCopyServerAddressAction({
  page,
  settings,
  abortSignal,
  deadlineAt = Infinity,
  onDangerousSkipped = () => {}
}) {
  throwIfAborted(abortSignal);
  if (performance.now() >= deadlineAt) {
    return { success: false, result: 'время цикла истекло' };
  }
  const options = {
    ...settings,
    allowedOrigin: new URL(settings.url).origin,
    allowedSelectors: [],
    blockedSelectors: parseLineList(settings.blockedSelectors),
    blockedWords: parseLineList(settings.blockedActionWords)
      .map((word) => word.toLocaleLowerCase('ru-RU'))
  };
  const candidates = await collectSafeCandidates(
    page,
    options,
    abortSignal,
    [settings.copyServerAddressSelector]
  );
  if (candidates.dangerousSkipped > 0) onDangerousSkipped(candidates.dangerousSkipped);
  const button = candidates.buttons[0];
  if (!button) return { success: false, result: 'разрешённая кнопка копирования не найдена' };

  const started = performance.now();
  const urlBefore = safeUrl(page.url());
  try {
    const reinspection = await inspectCandidate(button.locator, button.selector, options, abortSignal);
    if (!reinspection.safe || reinspection.kind !== 'button') {
      return { success: false, result: 'кнопка больше не проходит безопасную проверку' };
    }
    const timeoutMs = Math.max(1, Math.min(settings.actionTimeoutMs, deadlineAt - performance.now()));
    await button.locator.scrollIntoViewIfNeeded({ timeout: timeoutMs });
    throwIfAborted(abortSignal);
    if (performance.now() >= deadlineAt) {
      return { success: false, result: 'время цикла истекло' };
    }
    await button.locator.click({
      timeout: Math.max(1, Math.min(settings.actionTimeoutMs, deadlineAt - performance.now()))
    });
    return {
      success: true,
      result: 'кнопка нажата',
      selector: button.selector,
      text: truncateText(button.text),
      urlBefore,
      urlAfter: safeUrl(page.url()),
      durationMs: Math.round(performance.now() - started)
    };
  } catch (error) {
    if (abortSignal.aborted || error.name === 'AbortError') throw createAbortError();
    return {
      success: false,
      result: truncateText(error.message || error, 140),
      selector: button.selector,
      text: truncateText(button.text),
      urlBefore,
      urlAfter: safeUrl(page.url()),
      durationMs: Math.round(performance.now() - started)
    };
  }
}

module.exports = {
  AUTO_CANDIDATE_SELECTORS,
  MANDATORY_BLOCKED_SELECTORS,
  MANDATORY_BLOCKED_TEXT_PATTERN,
  createSeededRandom,
  generateSeed,
  parseLineList,
  performCopyServerAddressAction,
  performRandomActions,
  randomInteger,
  safeUrl,
  throwIfAborted,
  truncateText
};
