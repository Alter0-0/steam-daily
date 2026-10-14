@echo off
cd /d "%~dp0"
title Steam Daily Server

REM Avoid starting a second server when the service is already running.
powershell -NoProfile -Command "$connection = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue; if ($connection) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo Steam Daily is already running at http://127.0.0.1:4173/steam-daily.html
  echo You can close this window. The existing server is still running.
  pause
  exit /b 0
)

echo Starting Steam Daily at http://127.0.0.1:4173/steam-daily.html
node server.mjs
echo.
echo The server stopped. Read the message above for the reason.
echo If the port is busy, open the address above instead of starting another copy.
pause
