@echo off
title Phone Gyro Control Launcher
cd /d "%~dp0"
echo Launching Phone Gyro Control Game with Public Tunnel...
echo Close this window to stop both servers.
echo.
node run.js
pause
