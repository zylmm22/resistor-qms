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
where node >nul 2>nul
if %errorlevel%==0 goto run
echo [ERROR] Node.js not found.
echo         Install Node.js 22.5 or newer from https://nodejs.org
echo         then reopen this window.
pause
exit /b 1
:run
node server.js
echo.
echo Service stopped. Press any key to close.
pause >nul
