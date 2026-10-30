@echo off
title BioCloud IoT - Smart Healthcare Monitoring System
color 0B
echo ===================================================================
echo     BioCloud IoT - Smart Healthcare Monitoring (IoT + Cloud)
echo ===================================================================
echo.
cd /d "%~dp0"

echo [1/3] Starting BioCloud Server on Port 3000...
start "BioCloud Server" cmd /k "node server.js"

timeout /t 2 >nul

echo [2/3] Starting Cloudflare Cloud Edge Gateway...
start "Cloudflare Edge Tunnel" cmd /k "cloudflared tunnel --url http://localhost:3000"

timeout /t 3 >nul

echo [3/3] Opening BioCloud Dashboard in your browser...
start http://localhost:3000

echo.
echo ===================================================================
echo   System running successfully!
echo   - Local PC Dashboard: http://localhost:3000
echo   - Public Cloud HTTPS: See the "Cloudflare Edge Tunnel" window
echo ===================================================================
echo Keep the opened command windows running while using the project.
echo.
pause
