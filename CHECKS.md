# Выполненные проверки

Дата: 30 июля 2026 года

Версия: 1.3.0

Платформа: Windows x64

| Проверка | Результат |
|---|---|
| Electron | `v43.2.0` |
| Playwright | `1.62.0` |
| Chromium | Установлены Chromium 1234, headless shell, FFmpeg и Winldd |
| Синтаксис JavaScript | Успешно для main, preload, renderer, scheduler, runtime-utils, random-actions и тестовых скриптов |
| `git diff --check` | Успешно |
| Scheduler self-test | `SCHEDULER_SELF_TEST_OK` |
| Duration/shutdown utils self-test | `RUNTIME_UTILS_SELF_TEST_OK`: фиксированный режим, обе границы диапазона и тайм-аут зависшего Promise |
| UI contract self-test | `UI_CONTRACT_SELF_TEST_OK`: новые поля, тумблеры, показатели и колонки таблицы присутствуют |
| Random actions self-test | `RANDOM_ACTIONS_SELF_TEST_OK`: seed, белый и чёрный списки, опасный текст, формы, auto-discovery, origin, прокрутка, копирование, дедлайн и AbortSignal |
| Изоляция параллельных BrowserContext | `BROWSER_ISOLATION_OK` |
| Повторные BrowserContext | `REPEAT_BROWSER_SELF_TEST_OK`: 3 слота × 3 цикла, 9 уникальных контекстов |
| Изоляция повторов | Cookies, `localStorage` и `sessionStorage` пусты в начале каждого цикла |
| Обычный Electron smoke test | Код 0 |
| Циклический Electron smoke test | Код 0: 2 слота × 3 цикла |
| Стрессовая остановка | Код 0: остановлены 12 одновременно зависших загрузок |
| Random actions Electron smoke test | Код 0: фиксированный seed, два разрешённых клика, опасные элементы пропущены, внешний переход заблокирован |
| Packaged win-unpacked smoke tests | Циклы, random-actions и остановка: код 0 |
| Portable smoke tests | Random-actions и остановка: код 0 |
| Production audit | `found 0 vulnerabilities` |
| Содержимое ASAR | Подтверждены main, random-actions, package.json, HTML и renderer |
| Встроенный Chromium | `chrome.exe` найден в `app.asar.unpacked` |
| Portable x64 | Успешно, 280 741 377 байт |
| NSIS installer x64 | Успешно, 328 621 381 байт |

## Контрольные суммы SHA-256

```text
F0940EE981D0DA7B6EFC193535D917C59DD98E39DEA78E6503D81A8BFAFA42AD  Local Site Visitor-1.3.0-x64-portable.exe
83FDE9C72AE2649DD9BB3202B97B42B549B42E89A1F91634C2A77AA15C3C7BCD  Local Site Visitor-1.3.0-x64-setup.exe
```

Сборки не подписаны коммерческим сертификатом издателя. Windows SmartScreen может показать стандартное предупреждение для нового неподписанного приложения.
