# Выполненные проверки

Дата: 30 июля 2026 года

Версия: 1.2.0

Платформа: Windows x64

| Проверка | Результат |
|---|---|
| `npm install` | Успешно, зависимости и проектный Chromium установлены |
| Electron | `v43.2.0` |
| Playwright | `1.62.0` |
| Chromium | Установлены Chromium 1234, headless shell, FFmpeg и Winldd |
| Синтаксис JavaScript | Успешно для main, preload, renderer, scheduler, runtime-utils и тестовых скриптов |
| `git diff --check` | Успешно |
| Scheduler self-test | `SCHEDULER_SELF_TEST_OK` |
| Duration/shutdown utils self-test | `RUNTIME_UTILS_SELF_TEST_OK`: фиксированный режим, обе границы диапазона и тайм-аут зависшего Promise |
| UI contract self-test | `UI_CONTRACT_SELF_TEST_OK` |
| Изоляция параллельных BrowserContext | `BROWSER_ISOLATION_OK` |
| Повторные BrowserContext | `REPEAT_BROWSER_SELF_TEST_OK`: 3 слота × 3 цикла, 9 уникальных контекстов |
| Изоляция повторов | Cookies, `localStorage` и `sessionStorage` пусты в начале каждого цикла |
| Ограничение параллельности | Пиковое число открытых контекстов равно числу worker-слотов |
| Обычный Electron smoke test | `SMOKE_TEST_OK` |
| Циклический Electron smoke test | `CYCLE_SMOKE_TEST_OK`: 2 слота × 3 цикла, проверены счётчики |
| Стрессовая остановка | `STOP_SMOKE_TEST_OK`: остановлены 12 одновременно зависших загрузок |
| Packaged циклический и stop smoke tests | Код 0 |
| Portable stop smoke test | Код 0 |
| Остаточные процессы | После stop smoke процессов Chromium/Electron из проекта не осталось |
| Production audit | `found 0 vulnerabilities` |
| Содержимое ASAR | Подтверждены main, preload, scheduler, runtime-utils, package.json, HTML, CSS и renderer |
| Встроенный Chromium | `chrome.exe` найден в `app.asar.unpacked` |
| Portable x64 | Успешно, 280 646 269 байт |
| NSIS installer x64 | Успешно, 328 612 563 байта |

## Контрольные суммы SHA-256

```text
EF2B51D059C47A0B891DE3DFC12DC89E84149AF9DDBAA09647FCA433C1219919  Local Site Visitor-1.2.0-x64-portable.exe
9898894699CA0ED9E7C342707A0DF7814F518FC2D0970A602463480E5502117D  Local Site Visitor-1.2.0-x64-setup.exe
```

Сборки не подписаны коммерческим сертификатом издателя. Windows SmartScreen может показать стандартное предупреждение для нового неподписанного приложения.
