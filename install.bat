@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title Install Multi-platform Product Price Comparison

set "_BIJIA_SOCKS_PROXY="
set "_BIJIA_PIP_ARGS="
if /i "%HTTP_PROXY:~0,5%"=="socks" set "_BIJIA_SOCKS_PROXY=1"
if /i "%HTTPS_PROXY:~0,5%"=="socks" set "_BIJIA_SOCKS_PROXY=1"
if /i "%ALL_PROXY:~0,5%"=="socks" set "_BIJIA_SOCKS_PROXY=1"
if defined _BIJIA_SOCKS_PROXY (
    echo SOCKS proxy detected. Using a direct connection for dependency installation.
    set "HTTP_PROXY="
    set "HTTPS_PROXY="
    set "ALL_PROXY="
    set "http_proxy="
    set "https_proxy="
    set "all_proxy="
    set "_BIJIA_PIP_ARGS=--index-url https://mirrors.aliyun.com/pypi/simple/"
)

echo [1/5] Checking Python...
where py >nul 2>nul
if not errorlevel 1 (
    py -3 -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
    if not errorlevel 1 (
        py -3 -m venv ".venv"
        goto python_ready
    )
)

where python >nul 2>nul
if errorlevel 1 goto python_missing
python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>nul
if errorlevel 1 goto python_missing
python -m venv ".venv"

:python_ready
if errorlevel 1 goto install_failed
if not exist ".venv\Scripts\python.exe" goto install_failed

echo [2/5] Installing Python packages...
".venv\Scripts\python.exe" -m pip install %_BIJIA_PIP_ARGS% --upgrade pip
if errorlevel 1 goto install_failed
".venv\Scripts\python.exe" -m pip install %_BIJIA_PIP_ARGS% -r "backend\requirements-runtime.txt"
if errorlevel 1 goto install_failed

echo [3/5] Installing the Playwright Chromium browser...
if defined _BIJIA_SOCKS_PROXY set "PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright"
".venv\Scripts\python.exe" -m playwright install chromium
if errorlevel 1 goto install_failed

echo [4/5] Checking Node.js 20 or newer...
where node >nul 2>nul
if errorlevel 1 goto node_missing
node -e "const major=Number(process.versions.node.split('.')[0]); process.exit(major >= 20 ? 0 : 1)"
if errorlevel 1 goto node_missing
where npm >nul 2>nul
if errorlevel 1 goto node_missing

echo [5/5] Installing the 1688 runtime packages...
pushd "vendor\1688-cli"
set BB1688_SKIP_POSTINSTALL=1
call npm ci --omit=dev
set BB1688_SKIP_POSTINSTALL=
if errorlevel 1 (
    popd
    goto install_failed
)
popd

if not exist "data" mkdir "data"
if not exist "cookies" mkdir "cookies"
if not exist "browser_profiles" mkdir "browser_profiles"

echo.
echo Installation completed. Double-click start.bat to run the application.
pause
exit /b 0

:python_missing
echo.
echo Python 3.11 or newer was not found.
echo Download it from https://www.python.org/downloads/windows/
pause
exit /b 1

:node_missing
echo.
echo Node.js 20 or newer was not found.
echo Download an LTS version from https://nodejs.org/
pause
exit /b 1

:install_failed
echo.
echo Installation failed. Check the network connection and the error above.
pause
exit /b 1
