#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
screen_geometry="${VIRTUAL_SCREEN:-1366x768x24}"

Xvfb "$DISPLAY" -screen 0 "$screen_geometry" -ac -nolisten tcp >/tmp/xvfb.log 2>&1 &

display_number="${DISPLAY#:}"
display_number="${display_number%%.*}"
display_socket="/tmp/.X11-unix/X${display_number}"
for _ in $(seq 1 50); do
    if [ -S "$display_socket" ]; then
        break
    fi
    sleep 0.1
done

if [ ! -S "$display_socket" ]; then
    echo "Virtual display failed to start" >&2
    exit 1
fi

fluxbox >/tmp/fluxbox.log 2>&1 &
x11vnc \
    -display "$DISPLAY" \
    -forever \
    -shared \
    -localhost \
    -rfbport 5900 \
    -nopw \
    -noxdamage \
    >/tmp/x11vnc.log 2>&1 &
websockify --web=/usr/share/novnc/ 6080 localhost:5900 >/tmp/websockify.log 2>&1 &

exec uvicorn backend.main:app \
    --host 0.0.0.0 \
    --port 8000 \
    --proxy-headers \
    --forwarded-allow-ips='*'
