@echo off
title SUDS - SUD Navigator Services Tracker
cd /d "%~dp0\.."
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo.
  echo  Node.js is not installed. Please install it first:
  echo    1. Open https://nodejs.org in your browser
  echo    2. Download the "LTS" version and run the installer, accepting the defaults
  echo    3. Double-click Start-SUDS.bat again
  echo.
  start https://nodejs.org
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)"
if %errorlevel% neq 0 (
  echo  SUDS needs Node.js 22 or newer. Please update Node.js from https://nodejs.org and try again.
  pause
  exit /b 1
)
set SUDS_ENV=production
node scripts\print-url.js > "%TEMP%\suds-url.txt"
set /p SUDS_URL=<"%TEMP%\suds-url.txt"
echo  Starting SUDS at %SUDS_URL%
echo  Keep this window open while using the app. Close it to stop SUDS.
start "" "%SUDS_URL%"
node --no-warnings=ExperimentalWarning server\index.js
pause
