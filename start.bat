@echo off
cd /d "%~dp0"
node src\main.js
if errorlevel 1 pause
