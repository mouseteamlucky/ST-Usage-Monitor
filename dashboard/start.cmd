@echo off
rem Starts the ST-Usage-Monitor web dashboard (zero dependency).
rem Usage:  start.cmd ["<SillyTavern>\data"]
cd /d "%~dp0"
if "%~1"=="" (
  start "" /min cmd /c "node serve.mjs"
) else (
  start "" /min cmd /c "node serve.mjs --data-root \"%~1\""
)
"%SystemRoot%\System32\timeout.exe" /t 2 /nobreak >nul
start "" http://127.0.0.1:8899/
echo Dashboard: http://127.0.0.1:8899/   (close the minimized node window to stop)
