# Выполненные проверки

Дата: 30 июля 2026 года

Версия: 1.1.0

Платформа: Windows x64

| Проверка | Результат |
|---|---|
| `npm install` | Успешно, зависимости и проектный Chromium установлены |
| Electron | `v43.2.0` |
| Playwright | `1.62.0` |
| Chromium | Установлены Chromium 1234, headless shell, FFmpeg и Winldd |
| Синтаксис JavaScript | Успешно для main, preload, renderer, scheduler и тестовых скриптов |
| `git diff --check` | Успешно |
| Scheduler self-test | `SCHEDULER_SELF_TEST_OK` |
| UI contract self-test | `UI_CONTRACT_SELF_TEST_OK` |
| Изоляция параллельных BrowserContext | `BROWSER_ISOLATION_OK` |
| Повторные BrowserContext | `REPEAT_BROWSER_SELF_TEST_OK`: 3 слота × 3 цикла, 9 уникальных контекстов |
| Изоляция повторов | Cookies, `localStorage` и `sessionStorage` пусты в начале каждого цикла |
| Ограничение параллельности | Пиковое число открытых контекстов равно числу worker-слотов |
| Обычный Electron smoke test | `SMOKE_TEST_OK` |
| Циклический Electron smoke test | `CYCLE_SMOKE_TEST_OK`: 2 слота × 3 цикла, проверены счётчики |
| Packaged циклический smoke test | Код 0 |
| Portable циклический smoke test | Код 0 |
| Production audit | `found 0 vulnerabilities` |
| Содержимое ASAR | Подтверждены main, preload, scheduler, package.json, HTML, CSS и renderer |
| Встроенный Chromium | `chrome.exe` найден в `app.asar.unpacked` |
| Portable x64 | Успешно, 280 621 882 байта |
| NSIS installer x64 | Успешно, 328 610 935 байт |

## Контрольные суммы SHA-256

```text
81D5593E41EEB6B0641CE711173D06C00640B69898819406163F107D73236444  Local Site Visitor-1.1.0-x64-portable.exe
015CC5ADC96B1AC1463B51C3CA6896CD61B66607D177EB3F664A0F1530B401DB  Local Site Visitor-1.1.0-x64-setup.exe
```

Сборки не подписаны коммерческим сертификатом издателя. Windows SmartScreen может показать стандартное предупреждение для нового неподписанного приложения.
