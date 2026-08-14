@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Multi-platform Product Price Comparison

if not exist ".venv\Scripts\python.exe" (
    echo First-time setup is required. Starting install.bat...
    call install.bat
    if errorlevel 1 (
        echo.
        echo Installation failed. Please review the messages above.
        pause
        exit /b 1
    )
)

echo Starting the price comparison service...
".venv\Scripts\python.exe" run_server.py
if errorlevel 1 (
    echo.
    echo The service stopped with an error.
)
pause
