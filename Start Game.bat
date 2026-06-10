@echo off
title Apex Track Designer - server (close this window to stop the game)
cd /d "%~dp0"
start "" http://localhost:8080
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"
