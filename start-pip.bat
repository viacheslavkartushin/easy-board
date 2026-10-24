@echo off
cd /d "%~dp0"
where python >nul 2>nul || (echo Python 3.10+ not found. & pause & exit /b 1)
if not exist .venv\Scripts\python.exe python -m venv .venv || (pause & exit /b 1)
if not exist .venv\.installed (
  echo First run: installing requirements.txt ^(faster-whisper, ~200 MB, only for transcription^)...
  .venv\Scripts\python.exe -m pip install -r requirements.txt || (pause & exit /b 1)
  echo.>.venv\.installed
)
.venv\Scripts\python.exe main.py %*
pause
