@echo off
setlocal
cd /d "%~dp0.."

echo [INFO] Проверка Node.js...
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
  echo [ERROR] Node.js не найден. Установите актуальную LTS-версию с https://nodejs.org/
  exit /b 1
)

node --version
if %ERRORLEVEL% neq 0 (
  echo [ERROR] Не удалось запустить Node.js.
  exit /b 1
)

echo [INFO] Установка зависимостей...
call npm install
if %ERRORLEVEL% neq 0 (
  echo [ERROR] npm install завершился с ошибкой.
  exit /b 1
)

echo [INFO] Проверка Chromium для Playwright...
set PLAYWRIGHT_BROWSERS_PATH=0
call npx playwright install chromium
if %ERRORLEVEL% neq 0 (
  echo [ERROR] Не удалось установить Chromium.
  exit /b 1
)

if not exist "node_modules\.bin\electron.cmd" (
  echo [ERROR] Electron не установлен, хотя npm install завершился.
  exit /b 1
)

echo [OK] Зависимости и Chromium установлены.
exit /b 0
