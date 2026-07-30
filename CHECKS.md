# Выполненные проверки

Дата: 30 июля 2026 года  
Платформа: Windows x64

| Проверка | Результат |
|---|---|
| `npm install` | Успешно, создан `package-lock.json`, установлено 286 пакетов |
| Electron | `v43.2.0` |
| Playwright | `1.62.0` |
| Chromium | Установлены Chromium 1234, headless shell, FFmpeg и Winldd |
| Синтаксис `main.js` | Успешно (`node --check`) |
| Синтаксис `preload.js` | Успешно (`node --check`) |
| Синтаксис `src/renderer.js` | Успешно (`node --check`) |
| Синтаксис `scripts/self-test.js` | Успешно (`node --check`) |
| Smoke test исходного Electron-приложения | `SMOKE_TEST_OK`, код 0 |
| Изоляция BrowserContext | `BROWSER_ISOLATION_OK`: cookies и `localStorage` не переносятся во второй контекст |
| Smoke test packaged приложения | Код 0 |
| Smoke test portable EXE | Код 0 |
| Production audit | `found 0 vulnerabilities` |
| Содержимое ASAR | Подтверждены `main.js`, `preload.js`, `package.json`, HTML, CSS и renderer |
| Встроенный Chromium | `chrome.exe` найден в `app.asar.unpacked` |
| Portable x64 | Успешно, 280 611 291 байт |
| NSIS installer x64 | Успешно, 328 608 412 байт |

## Контрольные суммы SHA-256

```text
D532E4A0175CD5C58F436B78D39B893BF8D643886F9BAA8D50B83E3231645EFB  Local Site Visitor-1.0.0-x64-portable.exe
8BCD471A965266A38C6DE973D9580847ACC99D2AD73DC324076AAE62C6CCFBF4  Local Site Visitor-1.0.0-x64-setup.exe
```

Сборки не подписаны коммерческим сертификатом издателя. Windows SmartScreen может показать стандартное предупреждение для нового неподписанного приложения.
