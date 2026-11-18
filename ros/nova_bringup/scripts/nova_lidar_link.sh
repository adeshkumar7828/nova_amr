#!/usr/bin/env bash
# nova_lidar_link - creates /tmp/ttyNOVA_LIDAR: a virtual serial port connected over Wi-Fi
# to the LiDAR bridge on Nova's ESP32 (TCP 8899). The Slamtec driver opens it like a USB port.
#
#   ros2 run nova_bringup nova_lidar_link.sh [server]      (normally started by lidar.launch.py)
#
# Nova's IP comes from the Nova server (GET /api/status). server = "auto" tries
# http://localhost:8090 first (WSL mirrored mode), then the Windows host (WSL normal mode).
#
# Only ONE program may read the LiDAR: on the Nova page (Safe drive -> LiDAR link) the
# switch must be on "ROS". This script waits until it is.
# Ctrl+C: socat closes at once -> the ESP32 stops the LiDAR and is free for the next start.
PORT_FILE=/tmp/ttyNOVA_LIDAR
SERVER_ARG="${1:-auto}"
case "$SERVER_ARG" in --ros-args*) SERVER_ARG=auto ;; esac
CHILD=""

cleanup() {
  trap - INT TERM HUP
  if [ -n "$CHILD" ]; then kill "$CHILD" 2>/dev/null; wait "$CHILD" 2>/dev/null; fi
  rm -f "$PORT_FILE"
  echo "[nova-lidar-link] closed"
  exit 0
}
trap cleanup INT TERM HUP
run() { "$@" & CHILD=$!; wait "$CHILD"; CHILD=""; }

find_server() {
  if [ "$SERVER_ARG" != "auto" ]; then echo "$SERVER_ARG"; return; fi
  local gw; gw=$(ip route 2>/dev/null | awk '/^default/ {print $3; exit}')
  for u in http://localhost:8090 ${gw:+http://$gw:8090}; do
    if curl -s --max-time 1 "$u/api/status" >/dev/null 2>&1; then echo "$u"; return; fi
  done
}

LAST=""
say() { if [ "$1" != "$LAST" ]; then echo "[nova-lidar-link] $1"; LAST="$1"; fi; }

while true; do
  SERVER=$(find_server)
  if [ -z "$SERVER" ]; then
    say "can't reach the Nova server (is 'npm start' running on Windows?). Retrying..."
    run sleep 2; continue
  fi
  read -r CONNECTED IP LPORT SOURCE < <(curl -s --max-time 2 "$SERVER/api/status" | python3 -c '
import sys, json
try:
    s = json.load(sys.stdin)
    r, l = s.get("robot", {}), s.get("lidar", {})
    print(int(bool(r.get("connected"))), r.get("ip") or "-", l.get("bridgePort") or "-", l.get("source") or "-")
except Exception:
    print(0, "-", "-", "-")')
  if [ "$CONNECTED" != "1" ] || [ "$LPORT" = "-" ]; then
    say "waiting for Nova (server $SERVER): Nova on and connected, firmware with LiDAR bridge?"
    run sleep 2; continue
  fi
  if [ "$SOURCE" != "jetson" ]; then
    say "Nova page: Safe drive -> LiDAR link -> click \"ROS\" (the laptop reader must let go first). Waiting..."
    run sleep 2; continue
  fi
  say "Nova LiDAR at $IP:$LPORT -> $PORT_FILE (server $SERVER)"
  run socat pty,link=$PORT_FILE,raw,echo=0 tcp:$IP:$LPORT,nodelay
  LAST=""
  echo "[nova-lidar-link] link dropped, retrying in 1 s"
  run sleep 1
done
