@echo off
REM SmartLift AI - start the backend (camera + RFID + lift mirror)
cd /d "%~dp0server"

if not exist .venv (
  echo Creating the Python virtual environment...
  python -m venv .venv
  if errorlevel 1 (
    echo Failed to create the venv. Is Python installed and on PATH?
    pause
    exit /b 1
  )
  echo Installing packages. This takes a few minutes the first time...
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\pip install -r requirements.txt
)

echo.
echo Starting the backend on http://localhost:8000
echo Leave this window open. Press Ctrl+C to stop.
echo.
.venv\Scripts\python -m uvicorn main:app --host 0.0.0.0 --port 8000
pause
