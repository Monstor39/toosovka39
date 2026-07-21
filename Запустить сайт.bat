@echo off
title DUBAI PARTY
cd /d "%~dp0"

echo ============================================
echo    DUBAI PARTY - starting website
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed.
  echo Please install it from https://nodejs.org
  echo then run this file again.
  echo.
  pause
  exit /b
)

if not exist "node_modules" (
  echo Installing dependencies, please wait...
  call npm install
  echo.
)

echo Starting server...
echo Browser will open in a few seconds at http://localhost:3000
echo (to stop the website - just close this window)
echo.

start "" /min cmd /c "ping -n 5 127.0.0.1 >nul & start http://localhost:3000"

node server.js

echo.
echo Server stopped. If you see an error above, send me the text.
pause
