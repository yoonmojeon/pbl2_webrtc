@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo FieldLink - Python + aiohttp / HTML + CSS + JavaScript / WebSocket + WebRTC
python run.py %*
if errorlevel 1 pause
