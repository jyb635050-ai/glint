@echo off
title Glint
cd /d "%~dp0"
where python >nul 2>nul || (echo [Glint] Python not found. Install it first:  winget install Python.Python.3.12 & pause & exit /b 1)
where ffmpeg >nul 2>nul || (echo [Glint] ffmpeg not found. Install it first:  winget install Gyan.FFmpeg  then reopen this window & pause & exit /b 1)
if not exist ".venv\Scripts\python.exe" python -m venv .venv
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements.txt
".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -U "yt-dlp[default]"
".venv\Scripts\python.exe" run.py --lan --port 8787 --open --tips
pause
