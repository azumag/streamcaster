@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-BLMF-Local.ps1" %*
echo.
pause
