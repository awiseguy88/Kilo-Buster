@echo off
setlocal
cd /d "%~dp0"
if "%PORT%"=="" set "PORT=43817"
for /f "delims=" %%i in ('node api-key.mjs') do set "API_AUTH_TOKEN=%%i"
if not defined API_AUTH_TOKEN (echo Unable to load API key. & exit /b 1)
echo API key: %API_AUTH_TOKEN%
echo API: http://127.0.0.1:%PORT%/v1
start "" "http://127.0.0.1:%PORT%/dashboard?token=%API_AUTH_TOKEN%"
node server.mjs
pause
