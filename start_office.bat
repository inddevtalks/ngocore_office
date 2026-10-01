@echo off
title Office Task Hub - Launcher
echo ========================================================
echo            NGOCORE OFFICE TASK HUB LAUNCHER
echo ========================================================
echo.
echo [1/2] Starting Python Flask Backend on port 5000...
start "Office Backend (Flask)" cmd /k "cd /d "%~dp0backend" && .venv\Scripts\python.exe app.py"

echo [2/2] Starting Vite React Frontend on port 5173...
start "Office Frontend (Vite React)" cmd /k "cd /d "%~dp0frontend" && npm run dev"

echo.
echo ========================================================
echo  SUCCESS: Both Backend and Frontend are now running!
echo  Open your browser and visit:
echo  http://localhost:5173
echo ========================================================
echo.
echo You can keep this window open or close it. Do not close the two new windows.
pause
