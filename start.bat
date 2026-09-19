@echo off
setlocal
cd /d "%~dp0"

echo.
echo   Hogo-QA-tool launcher
echo   ------------------------------------
echo.

rem --- locate node ---
where node >nul 2>nul
if errorlevel 1 (
  echo   [ERROR] Node.js not found in PATH.
  echo   Install Node.js 18+ from https://nodejs.org/ and retry.
  echo.
  pause
  exit /b 1
)

rem --- build server version if missing ---
if not exist "dist-server\index.html" (
  echo   First run: building, please wait...
  echo.
  call npx vite build >nul 2>nul
  if not exist "dist-server\index.html" (
    echo   [ERROR] Build failed. Run "npx vite build" to see details.
    echo.
    pause
    exit /b 1
  )
  echo   Build done.
  echo.
)

echo   Starting local server, browser will open shortly...
start "" http://127.0.0.1:8787/
node scripts\serve.mjs 8787

echo.
echo   Server stopped.
pause
