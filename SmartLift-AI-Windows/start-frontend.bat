@echo off
REM SmartLift AI - start the simulation dashboard
cd /d "%~dp0"

if not exist node_modules (
  echo Installing npm packages. This takes a few minutes the first time...
  call npm install
  if errorlevel 1 (
    echo npm install failed. Is Node.js installed?
    pause
    exit /b 1
  )
)

echo.
echo Dashboard starting. Open http://localhost:5173 in your browser.
echo Leave this window open. Press Ctrl+C to stop.
echo.
call npm run dev
pause
