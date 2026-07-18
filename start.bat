@echo off
title Phone Gyro Control Local Production Preview
cd /d "%~dp0"
echo Building and launching a local production preview...
echo The event version is deployed and served by Render.com.
echo Close this window to stop the local preview.
echo.
call npm run preview:prod
pause
