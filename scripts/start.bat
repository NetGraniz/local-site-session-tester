@echo off
setlocal
cd /d "%~dp0.."

if not exist "node_modules" (
  echo [INFO] Зависимости не найдены. Запуск установки...
  call "%~dp0install.bat"
  if %ERRORLEVEL% neq 0 exit /b 1
)

if not exist "node_modules\.bin\electron.cmd" (
  echo [WARN] Локальный Electron не найден. Повторная установка зависимостей...
  call npm install
  if %ERRORLEVEL% neq 0 (
    echo [ERROR] Не удалось установить Electron.
    exit /b 1
  )
)

if not exist "node_modules\.bin\electron.cmd" (
  echo [ERROR] Файл node_modules\.bin\electron.cmd отсутствует.
  echo [ERROR] Выполните scripts\install.bat и повторите запуск.
  exit /b 1
)

set PLAYWRIGHT_BROWSERS_PATH=0
echo [INFO] Запуск Local Site Visitor...
call npm start
set APP_EXIT_CODE=%ERRORLEVEL%
if %APP_EXIT_CODE% neq 0 echo [ERROR] Приложение завершилось с кодом %APP_EXIT_CODE%.
exit /b %APP_EXIT_CODE%
