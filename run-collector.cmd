@echo off
cd /d "%~dp0"
node collector.mjs >> data\collector.log 2>&1
exit /b %ERRORLEVEL%
