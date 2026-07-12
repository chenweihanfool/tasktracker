@echo off
REM Start Gantt Today-Line Proxy for Vikunja
REM This proxy injects custom CSS/JS into Vikunja's Gantt view:
REM   - Today vertical line
REM   - Click-drag to pan
REM   - Tasks grouped by project
REM
REM Architecture: Apache -> proxy (this) -> Vikunja
REM   Port 3456: proxy listens here (Apache proxies to this)
REM   Port 3457: Vikunja container (proxy forwards to this)

set GANTT_PROXY_PUBLIC_PORT=3456
set GANTT_PROXY_INTERNAL_PORT=3457

echo [gantt-proxy] Starting proxy on port %GANTT_PROXY_PUBLIC_PORT% -^> localhost:%GANTT_PROXY_INTERNAL_PORT%...
cd /d F:\WEBAPP\SRC\vikunja\scripts\gantt-today-line
node proxy.js
