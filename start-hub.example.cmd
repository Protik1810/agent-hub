@echo off
rem Starts the Agent Hub on the local network (Windows). Copy to start-hub.cmd and set your address.
rem The admin token is in data\admin-token.txt (created on first start).
cd /d "%~dp0"
set HUB_HOST=0.0.0.0
set HUB_PORT=7700
rem The address agents on other machines use (shown in onboarding prompts)
set HUB_PUBLIC_URL=http://192.168.1.10:7700
node server.mjs
