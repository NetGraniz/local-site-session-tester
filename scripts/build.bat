@echo off
setlocal
cd /d "%~dp0.."

if not exist "node_modules\.bin\electron.cmd" (
  echo [INFO] Требуется установка зависимостей...
  call "%~dp0install.bat"
  if %ERRORLEVEL% neq 0 exit /b 1
)

set PLAYWRIGHT_BROWSERS_PATH=0
if not exist "node_modules\playwright-core\.local-browsers" (
  echo [INFO] Установка Chromium для автономной сборки...
  call npx playwright install chromium
  if %ERRORLEVEL% neq 0 exit /b 1
)

echo [INFO] Сборка portable EXE...
call npm run pack:win
if %ERRORLEVEL% neq 0 (
  echo [ERROR] Не удалось создать portable EXE.
  exit /b 1
)

echo [INFO] Сборка NSIS installer...
call npm run dist:win
if %ERRORLEVEL% neq 0 (
  echo [ERROR] Не удалось создать NSIS installer.
  exit /b 1
)

echo [OK] Сборки созданы в:
echo %CD%\dist
exit /b 0
