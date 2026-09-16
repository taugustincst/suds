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
for /f "tokens=1 delims=v." %%a in ('node -v') do set NODEMAJOR=%%a
node -e "process.exit(Number(process.versions.node.split('.')[0])>=22?0:1)" || (
  echo  SUDS needs Node.js 22 or newer. Please update Node.js from https://nodejs.org and try again.
  pause
  exit /b 1
)
set SUDS_ENV=production
echo  Starting SUDS... keep this window open while using the app. Close it to stop SUDS.
if not exist "data\server.json" (
  start "" http://localhost:8080/
) else (
  node -e "const c=require('./data/server.json');require('child_process').exec('start \"\" '+(c.tls&&c.tls!=='none'?'https':'http')+'://localhost:'+(c.port||8080)+'/')"
)
node --no-warnings=ExperimentalWarning server\index.js
pause
