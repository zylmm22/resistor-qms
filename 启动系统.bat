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
if %errorlevel%==0 (node server.js) else ("C:\Users\zhany\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" server.js)
echo.
echo Service stopped. Press any key to close.
pause >nul
