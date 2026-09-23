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
  echo   Install Node.js 22.22.2 or newer from https://nodejs.org/ and retry.
  echo.
  pause
  exit /b 1
)

rem --- build server version if missing or STALE ---
rem Building only when dist-server\index.html is absent is NOT enough:
rem if the old bundle is still there, every later source change is silently
rem ignored and the user keeps running stale code ("the fix does not work").
rem Staleness check + rebuild lives in scripts\ensure-build.mjs.
node scripts\ensure-build.mjs
if errorlevel 1 (
  echo   [ERROR] Build failed. Run "npx vite build" to see details.
  echo.
  pause
  exit /b 1
)

echo   Starting local server, browser will open shortly...
start "" http://127.0.0.1:8787/
node scripts\serve.mjs 8787

echo.
echo   Server stopped.
pause
