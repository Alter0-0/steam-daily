@echo off
cd /d "%~dp0"
title Steam Daily Server

:check
powershell -NoProfile -Command "$connection = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue; if ($connection) { exit 0 } else { exit 1 }"
if not errorlevel 1 exit /b 0

echo Starting Steam Daily at http://127.0.0.1:4173/steam-daily.html
node server.mjs
echo The server stopped. Restarting in 5 seconds...
timeout /t 5 /nobreak >nul
goto check
