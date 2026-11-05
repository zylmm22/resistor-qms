@echo off
chcp 936 >nul
cd /d "%~dp0"
echo ============================================
echo   Resistor QMS  (dian zu qi zhi liang xi tong)
echo ============================================
echo.
echo   Browser: http://127.0.0.1:8848
echo   Close this window to stop the service.
echo.
rem Optional local fallback: Node runtime bundled with the DeepSeek Harness IDE.
rem Delete the next two lines if you only start the app with "node" on PATH.
where node >nul 2>nul
if %errorlevel%==0 goto run
set "LOCAL_NODE=%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if exist "%LOCAL_NODE%" goto runlocal
echo [ERROR] Node.js not found. Install Node.js 22.5+ from https://nodejs.org
echo         and make sure "node" is available on PATH.
pause
exit /b 1
:runlocal
"%LOCAL_NODE%" server.js
goto done
:run
node server.js
:done
echo.
echo Service stopped. Press any key to close.
pause >nul
